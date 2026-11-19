import { hostMatchesOrg, normalizeName, orgOverlap, sameName } from "@/lib/identity";
import { inspectUrls, type DirectoryLink, type FetchLogEntry, type InspectedPage } from "@/lib/inspect";
import { looksLikePerson, provisionalFromLead, type ProvisionalPerson } from "@/lib/extract";
import {
  hostOf,
  isInstitutionalHost,
  isNoiseHost,
  isSafePublicUrl,
  normalizeUrl,
  type Lead,
} from "@/lib/leads";
import { searchOpenAlex } from "@/lib/openalex";
import { directoryLeads, type OrgRecord } from "@/lib/orgs";
import { errMessage, pool } from "@/lib/pool";
import { braveConfigured, braveDiscover } from "@/lib/providers/brave";
import { exaConfigured, exaDiscover, exaSearch } from "@/lib/providers/exa";
import { share, specificTopic, terms as termsOf } from "@/lib/rank";
import { stateName } from "@/lib/states";
import {
  deriveContact,
  deriveFocus,
  deriveLocation,
  deriveOrgs,
  deriveStage,
  openQuestions,
  toPersonPage,
  toProfile,
  unknownClaim,
  type PersonPage,
} from "@/lib/verify";
import { webQueryTexts, institutionalQueries, type WebQuery } from "@/lib/webQueries";
import { llmQueries } from "@/lib/llmQueries";
import { broadQueries, registrableDomain, FIRST_PASS_SITE_SEARCHES, EXPANSION_SITE_SEARCHES, THIN_POOL, shortlistOrgs, type OrgCandidate } from "@/lib/orgSelect";
import {
  MAX_RESULTS,
  type Candidate,
  type Evidence,
  type DiscoveredLead,
  type Facets,
  type LeadLogEntry,
  type QueryPlan,
  type SearchRequest,
  type SourceError,
  type SourceStat,
} from "@/types/search";

// Adaptive inspection budget: batches continue while they still find on-topic people.
const MAX_INSPECT_LEADS = 120; // hard cap on cold pages
const INSPECT_BATCH = 20;
const INSPECT_TIME_MS = 30_000;
const STATE_SITE_SEARCHES = 12; // one site search per in-state organization, evidence-ordered
const MAX_DIRECTORY_FOLLOW = 40; // profile and personal-site pages followed from directory pages
const FOLLOW_PER_DIRECTORY = 12;
const MAX_AUTHOR_LOOKUPS = 15; // only the most promising people get a per-person lookup
const LOOKUP_RESULTS = 5;
const POOL_PER_RESULT = 3;

export type DiscoveryOutcome = {
  candidates: Candidate[];
  errors: SourceError[];
  sources: SourceStat[];
  notes: string[];
  poolFull: boolean;
  leadLog: LeadLogEntry[];
  discovered: DiscoveredLead[];
};

/* ---------- helpers ---------- */

type Person = {
  id: string;
  name: string;
  author: Candidate | null; // OpenAlex-derived base, if any
  pages: PersonPage[];
  provisional: ProvisionalPerson[]; // leads whose page could not be read
  foundBy: Set<string>;
  queries: Set<string>;
};

function webEvidence(p: PersonPage): Evidence {
  return {
    type: "profile",
    label: p.headline || `${p.name} profile`,
    url: p.url,
    date: p.retrievedAt.slice(0, 10),
  };
}

type Mention = { name: string; orgs: string[]; url: string };

function supports(m: Mention, person: Person): boolean {
  if (!sameName(m.name, person.name)) return false;
  // A missing affiliation is unknown, not a conflict. Only a stated, different
  // organization blocks the link.
  const known = [
    ...(person.author?.organizations.map((o) => o.name) ?? []),
    ...person.pages.flatMap((p) => p.orgs),
  ];
  if (known.length === 0 || m.orgs.length === 0) return true;
  return orgOverlap(known, m.orgs) || hostMatchesOrg(hostOf(m.url), known);
}

const sourcesKey = (u: string) => normalizeUrl(u);

/** Terms from the topic and related concepts, used only to choose which directory entries to follow. */
function topicTerms(f: Facets): string[] {
  return [...new Set([f.topic, ...f.related].join(" ").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 5))];
}

const sameSite = (a: string, b: string) => {
  const x = hostOf(a).split(".").slice(-2).join(".");
  return x !== "" && x === hostOf(b).split(".").slice(-2).join(".");
};

/* ---------- discovery ---------- */

export async function discoverPeople(
  req: SearchRequest,
  plan: QueryPlan,
  facets: Facets,
  orgs: OrgRecord[],
): Promise<DiscoveryOutcome> {
  const errors: SourceError[] = [];
  const notes: string[] = [];
  const leadLog: LeadLogEntry[] = [];
  const now = new Date().toISOString();
  const institution = facets.institution;
  const q = webQueryTexts(facets, stateName(req.state));
  // No state and no institution: topic-led discovery decides where to look.
  const topicLed = !institution && !req.state;
  const webSet = topicLed ? broadQueries(facets.topic) : q.web;

  // 1. Every path runs in parallel. None is restricted to one index.
  //    The LLM only proposes extra search phrasings; its queries run through the
  //    same providers and every person still has to be found on a real page.
  const target = req.stages.length ? MAX_RESULTS * POOL_PER_RESULT : MAX_RESULTS;
  const llmRun = llmQueries(facets, stateName(req.state)).then(async (r) => {
    if (r.error) errors.push({ source: "anthropic", message: r.error });
    if (!r.queries.length) return { leads: [] as Lead[], errors: [] as SourceError[], n: 0, people: [] as string[], own: [] as Lead[] };
    // Named people: one small web search each (their own page is usually the top hit).
    // Topic phrasings: Brave, which handles lab/department pages well. One call per query.
    const persons = r.queries.filter((x) => x.branch === "llm-person");
    const topics = r.queries.filter((x) => x.branch !== "llm-person");
    const [a, b] = await Promise.all([exaDiscover(persons, false), braveConfigured() ? braveDiscover(topics) : exaDiscover(topics, false)]);
    // For each named person, the top institutional hits that carry their surname:
    // these are read before the general queue, so the cap cannot cut them.
    const own: Lead[] = [];
    for (const name of r.people ?? []) {
      const last = name.split(" ").pop()!.toLowerCase();
      own.push(
        ...a.leads
          .filter((l) => `${l.url} ${l.title ?? ""}`.toLowerCase().includes(last) && isInstitutionalHost(hostOf(l.url)))
          .slice(0, 2),
      );
    }
    return { leads: [...a.leads, ...b.leads], errors: [...a.errors, ...b.errors], n: r.queries.length, people: r.people ?? [], own };
  });
  const [oa, exaPeople, exaWeb, brave, llm] = await Promise.all([
    searchOpenAlex(req, plan, target, institution?.openalexId ?? null).catch((e) => {
      errors.push({ source: "openalex", message: errMessage(e) });
      return null;
    }),
    exaDiscover(q.people, true),
    exaDiscover(webSet.slice(0, 4), false),
    braveDiscover(webSet),
    llmRun,
  ]);
  for (const out of [exaPeople, exaWeb, brave, llm]) errors.push(...out.errors);
  if (llm.n) notes.push(`LLM widening: ${llm.n} extra queries, ${llm.leads.length} leads.`);
  // LLM leads keep their own source so they get their own inspection queue
  // (and are read first), instead of queuing behind exa-web's long list.
  const llmLeads = llm.leads.map((l): Lead => ({ ...l, source: "llm" }));
  if (oa) errors.push(...oa.errors);

  const skipped = [!exaConfigured() && "Exa", !braveConfigured() && "Brave"].filter(Boolean);
  if (skipped.length) notes.push(`Skipped (no API key): ${skipped.join(", ")}.`);

  // 2. Combine leads. One URL is inspected once, however many paths found it.
  // Institutional path: site-restricted searches on the named institution's domains,
  // or on the selected state's universities when none is named. Known directory
  // URLs from organization records are added too.
  const scoped = orgs.filter((o) => !institution || o.id === institution.openalexId);
  let instSeedDomains: string[];
  let shortlist: OrgCandidate[] = [];
  if (institution) {
    instSeedDomains = institution.domains;
  } else if (req.state) {
    // People first: the broad searches and OpenAlex already ran. Every organization in
    // the state (universities, institutes, hospitals) is then ordered by how many of
    // those people show topic evidence there, and site-searched in that order. Ones
    // with no evidence yet still get a search, after the evidenced ones, up to the cap.
    const inState = scoped.filter((o) => o.state === req.state && o.domains.length > 0);
    const evidence = await shortlistOrgs(facets, [...exaPeople.leads, ...exaWeb.leads, ...brave.leads], oa?.candidates ?? []);
    const scoreOf = new Map(evidence.map((o) => [o.domain, o.score]));
    const rankOf = (o: OrgRecord) => Math.max(0, ...o.domains.map((d) => scoreOf.get(registrableDomain(d)) ?? 0));
    const ordered = [...inState].sort((a, b) => rankOf(b) - rankOf(a) || (a.type === "university" ? -1 : 1));
    instSeedDomains = ordered.slice(0, STATE_SITE_SEARCHES).map((o) => o.domains[0]);
    const withEvidence = ordered.filter((o) => rankOf(o) > 0).length;
    notes.push(
      `${stateName(req.state)}: ${inState.length} organizations known; site-searched ${instSeedDomains.length} (${withEvidence} with topic evidence first).`,
    );
  } else {
    // Topic-led: choose organizations from what the broad searches and OpenAlex surfaced.
    shortlist = await shortlistOrgs(facets, [...exaPeople.leads, ...exaWeb.leads, ...brave.leads], oa?.candidates ?? []);
    instSeedDomains = shortlist.slice(0, FIRST_PASS_SITE_SEARCHES).map((o) => o.domain);
    notes.push(
      shortlist.length
        ? `Topic-led discovery chose ${instSeedDomains.length} organization${instSeedDomains.length === 1 ? "" : "s"} for a site search: ${instSeedDomains.join(", ")}.`
        : "Topic-led discovery found no organization with specific topic evidence, so no site search ran.",
    );
  }
  const instQueries = institutionalQueries(
    facets,
    instSeedDomains,
    topicLed ? { perDomain: 1, max: FIRST_PASS_SITE_SEARCHES } : !institution && req.state ? { perDomain: 1, max: STATE_SITE_SEARCHES } : {},
  );
  // One site search per domain: Brave when configured (it supports site:), else Exa.
  const siteSearch = (qs: WebQuery[]) => (braveConfigured() ? braveDiscover(qs) : exaDiscover(qs, false));
  const [instExa, instBrave] = topicLed
    ? [await siteSearch(instQueries), { leads: [] as Lead[], errors: [] as SourceError[] }]
    : await Promise.all([exaDiscover(instQueries, false), braveDiscover(instQueries.slice(0, 3))]);
  for (const out of [instExa, instBrave]) errors.push(...out.errors);
  const asInstitutional = (l: Lead): Lead => ({ ...l, source: "institutional" });
  const institutional = [
    ...directoryLeads(scoped),
    ...instExa.leads.map(asInstitutional),
    ...instBrave.leads.map(asInstitutional),
  ];
  if (instSeedDomains.length === 0 && (institution || req.state)) {
    notes.push("Institutional pages: no website domain known for the institution, so no site search ran.");
  }
  type Merged = Lead & { sources: Set<string>; queries: Set<string> };
  const byUrl = new Map<string, Merged>();
  for (const lead of [...llmLeads, ...exaPeople.leads, ...exaWeb.leads, ...brave.leads, ...institutional]) {
    const host = hostOf(lead.url);
    if (!isSafePublicUrl(lead.url) || isNoiseHost(host)) continue;
    const key = normalizeUrl(lead.url);
    const hit = byUrl.get(key) ?? { ...lead, sources: new Set<string>(), queries: new Set<string>() };
    hit.sources.add(lead.source);
    hit.queries.add(lead.queryId);
    if (!hit.snippet && lead.snippet) hit.snippet = lead.snippet;
    byUrl.set(key, hit);
  }
  const instDomains = institution?.domains ?? [];
  const onInstitution = (url: string) => instDomains.some((d) => hostOf(url) === d || hostOf(url).endsWith(`.${d}`));
  // The named institution's own pages, institutional hosts, and pages found by several paths come first.
  const ranked = [...byUrl.values()].sort(
    (a, b) =>
      Number(b.sources.has("llm")) - Number(a.sources.has("llm")) ||
      Number(onInstitution(b.url)) - Number(onInstitution(a.url)) ||
      Number(isInstitutionalHost(hostOf(b.url))) - Number(isInstitutionalHost(hostOf(a.url))) ||
      b.sources.size - a.sources.size,
  );
  // 2b. Cheap ranking from what discovery already returned (title, snippet, host,
  //     agreement between paths). No page is fetched for this.
  const topicWords = specificTopic(facets);
  const relatedWords = facets.related.flatMap((r) => termsOf(r));
  const cheap = (l: Merged) => {
    const text = `${l.title ?? ""} ${l.snippet ?? ""}`.toLowerCase();
    return (
      share(text, topicWords) * 3 +
      share(text, relatedWords) +
      Number(onInstitution(l.url)) +
      Number(isInstitutionalHost(hostOf(l.url))) * 0.5 +
      (l.sources.size - 1) * 0.5
    );
  };
  // Each source keeps its own queue, best first, and the budget is dealt round-robin,
  // so one provider's long list cannot crowd out a strong page only another path found.
  const queues = new Map<string, Merged[]>();
  for (const l of ranked) {
    const s = [...l.sources][0];
    queues.set(s, [...(queues.get(s) ?? []), l]);
  }
  for (const q of queues.values()) q.sort((a, b) => cheap(b) - cheap(a));
  const nextBatch = (n: number): Merged[] => {
    const out: Merged[] = [];
    while (out.length < n && [...queues.values()].some((q) => q.length)) {
      for (const q of queues.values()) {
        const next = q.shift();
        if (next && out.length < n) out.push(next);
      }
    }
    return out;
  };

  // 3. Adaptive inspection: read a batch, and keep going while batches still turn up
  //    on-topic people or directories. Stop at the page or time budget and say so.
  const leadsByKey = new Map<string, Merged>();
  const first = { pages: [] as InspectedPage[], failed: 0, parserError: null as string | null, fetchLog: [] as FetchLogEntry[] };
  const deadline = Date.now() + INSPECT_TIME_MS;
  let stopReason = "no more leads";
  // Pages of people the LLM named are read first and outside the budget (at most ~24).
  {
    const ownKeys = [...new Set(llm.own.map((l) => normalizeUrl(l.url)))].filter((k) => byUrl.has(k));
    const ownLeads = ownKeys.map((k) => byUrl.get(k)!);
    for (const q of queues.values()) for (let i = q.length - 1; i >= 0; i--) if (ownKeys.includes(normalizeUrl(q[i].url))) q.splice(i, 1);
    if (ownLeads.length) {
      for (const l of ownLeads) leadsByKey.set(normalizeUrl(l.url), l);
      const got = await inspectUrls(ownLeads.map((l) => l.url));
      first.pages.push(...got.pages);
      first.fetchLog.push(...got.fetchLog);
      first.failed += got.failed;
      first.parserError ??= got.parserError;
    }
  }
  while (true) {
    if (leadsByKey.size >= MAX_INSPECT_LEADS + llm.own.length) { stopReason = `page budget (${MAX_INSPECT_LEADS})`; break; }
    if (Date.now() > deadline) { stopReason = `time budget (${INSPECT_TIME_MS / 1000}s)`; break; }
    const batch = nextBatch(Math.min(INSPECT_BATCH, MAX_INSPECT_LEADS + llm.own.length - leadsByKey.size));
    if (batch.length === 0) break;
    for (const l of batch) leadsByKey.set(normalizeUrl(l.url), l);
    const got = await inspectUrls(batch.map((l) => l.url));
    first.pages.push(...got.pages);
    first.fetchLog.push(...got.fetchLog);
    first.failed += got.failed;
    first.parserError ??= got.parserError;
    const useful = got.pages.some(
      (p) =>
        (p.parsed.kind === "person" || p.parsed.kind === "directory") &&
        share(`${p.parsed.focus ?? ""} ${p.parsed.headline ?? ""}`.toLowerCase(), topicWords) > 0,
    );
    if (!useful) { stopReason = "a batch found no new on-topic people"; break; }
  }
  const remaining = [...queues.values()].reduce((s, q) => s + q.length, 0);
  notes.push(`Inspected ${leadsByKey.size} of ${byUrl.size} leads; stopped: ${stopReason}${remaining ? ` (${remaining} lower-ranked leads not read)` : ""}.`);
  if (first.parserError) errors.push({ source: "parser", message: first.parserError });
  if (first.failed > 0) notes.push(`${first.failed} lead page${first.failed === 1 ? "" : "s"} could not be fetched; kept as provisional where a name was readable.`);

  const provisionalFor = new Map<string, ProvisionalPerson>(); // normalized url -> person
  const addProvisional = (p: ProvisionalPerson | null) => {
    if (p) provisionalFor.set(normalizeUrl(p.url), p);
  };
  const log = (fetchLog: FetchLogEntry[], pages: InspectedPage[], sourceOf: (url: string) => string, from: Map<string, Lead>) => {
    const parsed = new Map(pages.map((p) => [normalizeUrl(p.fetched.url), p]));
    for (const f of fetchLog) {
      const key = normalizeUrl(f.url);
      const source = sourceOf(f.url);
      if (!f.ok) {
        const lead = from.get(key);
        const prov = lead ? provisionalFromLead(lead, institution, now) : null;
        addProvisional(prov);
        leadLog.push({
          url: f.url,
          source,
          fetch: "failed",
          extraction: prov ? "provisional" : "none",
          reason: `${f.error ?? "fetch failed"}${prov ? "" : "; no name readable from the search result"}`,
        });
        continue;
      }
      const page = parsed.get(key);
      const kind = page?.parsed.kind;
      leadLog.push({
        url: f.url,
        source,
        fetch: "ok",
        extraction: kind === "person" ? "person" : kind === "directory" ? "directory" : kind === "error" ? "error" : "other",
        reason:
          kind === "person" || kind === "directory"
            ? null
            : kind === "error"
              ? page?.parsed.error ?? "parser error"
              : page?.parsed.name
                ? "a name was found but the page does not read as a person profile"
                : "no personal name found on the page",
      });
    }
  };
  const firstSource = (u: string) => [...(leadsByKey.get(normalizeUrl(u))?.sources ?? ["web"])][0];
  log(first.fetchLog, first.pages, firstSource, new Map([...leadsByKey]));

  // 3b. Directories are candidate sources: each entry is one person. Follow the entry's
  //     profile link and its other links (such as a personal website), and remember
  //     whose they are so a page with no organization or location still attaches.
  const terms = topicTerms(facets);
  type Follow = { link: DirectoryLink; sources: Set<string>; queries: Set<string>; owner: string | null };
  const followMeta = new Map<string, Follow>();
  for (const page of first.pages) {
    if (page.parsed.kind !== "directory") continue;
    const parent = leadsByKey.get(normalizeUrl(page.fetched.url)) ?? leadsByKey.get(normalizeUrl(page.fetched.finalUrl));
    const links = (page.parsed.links ?? []).filter(
      (l) => isSafePublicUrl(l.url) && !isNoiseHost(hostOf(l.url)) && sameSite(l.url, page.fetched.finalUrl),
    );
    const topical = links.filter((l) => terms.some((t) => l.context.toLowerCase().includes(t)));
    const chosen = [...topical, ...links.filter((l) => !topical.includes(l))].slice(0, FOLLOW_PER_DIRECTORY);
    for (const link of chosen) {
      const sources = new Set([...(parent?.sources ?? []), "directory"]);
      const queries = parent?.queries ?? new Set<string>();
      const entries: Array<[string, DirectoryLink]> = [
        [link.url, link],
        ...link.others
          .filter((u) => isSafePublicUrl(u) && !isNoiseHost(hostOf(u)))
          .slice(0, 2)
          .map((u): [string, DirectoryLink] => [u, { ...link, url: u, others: [] }]),
      ];
      for (const [url, l] of entries) {
        if (followMeta.size >= MAX_DIRECTORY_FOLLOW) break;
        const key = normalizeUrl(url);
        if (byUrl.has(key) || followMeta.has(key)) continue;
        followMeta.set(key, { link: l, sources, queries, owner: link.name });
      }
    }
  }
  const followLeads = new Map<string, Lead>(
    [...followMeta].map(([k, m]) => [
      k,
      { url: m.link.url, title: m.link.name, snippet: m.link.context, source: "institutional" as const, queryId: "directory" },
    ]),
  );
  const second = followMeta.size
    ? await inspectUrls([...followMeta.values()].map((m) => m.link.url))
    : { pages: [] as InspectedPage[], failed: 0, parserError: null, fetchLog: [] as FetchLogEntry[] };
  if (second.parserError) errors.push({ source: "parser", message: second.parserError });
  log(second.fetchLog, second.pages, () => "directory", followLeads);
  if (followMeta.size) notes.push(`Followed ${followMeta.size} profile link${followMeta.size === 1 ? "" : "s"} from directory pages.`);

  // 4. Build people. OpenAlex authors are the base, web pages attach to them or stand alone.
  const people: Person[] = [];
  const addPerson = (name: string, author: Candidate | null): Person => {
    const p: Person = {
      id: author?.id ?? `web-${normalizeName(name).replace(/\s+/g, "-")}`,
      name,
      author,
      pages: [],
      provisional: [],
      foundBy: new Set(author ? ["openalex"] : []),
      queries: new Set(author?.matchedQueries ?? []),
    };
    people.push(p);
    return p;
  };
  for (const c of oa?.candidates ?? []) addPerson(c.name, c);

  const meta = (key: string) => {
    const lead = leadsByKey.get(key);
    const follow = followMeta.get(key);
    return {
      sources: lead?.sources ?? follow?.sources ?? new Set<string>(),
      queries: lead?.queries ?? follow?.queries ?? new Set<string>(),
    };
  };
  const find = (m: Mention): Person => people.find((p) => supports(m, p)) ?? addPerson(m.name, null);
  const tag = (person: Person, key: string) => {
    const { sources, queries } = meta(key);
    sources.forEach((s) => person.foundBy.add(s));
    queries.forEach((qq) => person.queries.add(qq));
  };
  const personPages = (list: InspectedPage[]) =>
    list.flatMap((p) => {
      const pp = toPersonPage(p);
      return pp ? [{ pp, key: normalizeUrl(p.fetched.url) }] : [];
    });
  for (const { pp, key } of personPages(first.pages)) {
    const person = find({ name: pp.name, orgs: pp.orgs, url: pp.url });
    if (!person.pages.some((x) => x.url === pp.url)) person.pages.push(pp);
    tag(person, key);
  }
  // Followed pages belong to the directory entry that linked them. Geography and
  // organization are read from the page afterwards, never required to attach it.
  const attachedFollow = new Set<string>();
  const ownerOf = (key: string) => followMeta.get(key)?.owner ?? null;
  const attachOwned = (pp: PersonPage, key: string) => {
    const owner = ownerOf(key);
    const person =
      owner && sameName(pp.name, owner)
        ? (people.find((p) => sameName(p.name, owner)) ?? addPerson(pp.name, null))
        : find({ name: pp.name, orgs: pp.orgs, url: pp.url });
    if (!person.pages.some((x) => x.url === pp.url)) person.pages.push(pp);
    tag(person, key);
    attachedFollow.add(key);
  };
  for (const { pp, key } of personPages(second.pages)) attachOwned(pp, key);
  for (const page of second.pages) {
    const key = normalizeUrl(page.fetched.url);
    const owner = ownerOf(key);
    if (attachedFollow.has(key) || !owner || page.parsed.kind === "error") continue;
    // A personal site often has no structured profile. Its text still counts for the
    // person who linked it, with no stage or state claimed from it.
    attachOwned(
      {
        url: page.fetched.finalUrl,
        retrievedAt: page.fetched.retrievedAt,
        institutional: isInstitutionalHost(hostOf(page.fetched.finalUrl)),
        name: owner,
        orgs: page.parsed.orgs ?? [],
        headline: page.parsed.headline ?? "",
        stageHits: [],
        states: [],
        focus: page.parsed.focus ?? null,
        emails: page.parsed.emails ?? [],
        contactPage: page.parsed.contact_page ?? null,
      },
      key,
    );
  }
  // Directory entries whose pages could not become a profile stay provisional,
  // so the entry's own text (such as the listed research area) is kept.
  for (const [key, entry] of followMeta) {
    if (provisionalFor.has(key) || attachedFollow.has(key)) continue;
    if (!looksLikePerson(entry.link.name)) continue;
    addProvisional({
      name: entry.link.name,
      org: institution?.name ?? null,
      url: entry.link.url,
      text: entry.link.context,
      retrievedAt: now,
    });
  }
  for (const [key, prov] of provisionalFor) {
    const person = find({ name: prov.name, orgs: prov.org ? [prov.org] : [], url: prov.url });
    if (!person.provisional.some((x) => x.url === prov.url)) person.provisional.push(prov);
    tag(person, key);
  }

  // 5. Publication authors have no profile yet. Look up a current page for the most
  //    active ones.
  const needLookup = people
    .filter((p) => p.author && p.pages.length === 0)
    .sort((a, b) => (b.author?.score ?? 0) - (a.author?.score ?? 0))
    .slice(0, MAX_AUTHOR_LOOKUPS);

  if (exaConfigured() && needLookup.length > 0) {
    const region = institution ? "" : stateName(req.state) ?? "";
    const lookups = await pool(
      needLookup.map((p) => async () => {
        const org = institution?.name ?? p.author?.organizations[0]?.name ?? "";
        const hits = await exaSearch(`${p.name} ${org} ${region} faculty OR researcher profile`, false, LOOKUP_RESULTS);
        return { person: p, urls: hits.map((h) => h.url).filter((u) => !isNoiseHost(hostOf(u))) };
      }),
      3,
    );
    const urls = new Set<string>();
    const owners = new Map<string, Person[]>();
    lookups.forEach((r, i) => {
      if (r.status === "rejected") {
        errors.push({ source: `lookup:${needLookup[i].name}`, message: errMessage(r.reason) });
        return;
      }
      for (const u of r.value.urls) {
        urls.add(u);
        owners.set(normalizeUrl(u), [...(owners.get(normalizeUrl(u)) ?? []), r.value.person]);
      }
    });
    const looked = await inspectUrls([...urls].slice(0, MAX_AUTHOR_LOOKUPS * LOOKUP_RESULTS));
    if (looked.parserError) errors.push({ source: "parser", message: looked.parserError });
    for (const f of looked.fetchLog) {
      leadLog.push({
        url: f.url,
        source: "lookup",
        fetch: f.ok ? "ok" : "failed",
        extraction: f.ok ? "other" : "none",
        reason: f.error,
      });
    }
    for (const { pp, key } of personPages(looked.pages)) {
      for (const owner of owners.get(key) ?? []) {
        if (supports({ name: pp.name, orgs: pp.orgs, url: pp.url }, owner) && !owner.pages.some((x) => x.url === pp.url)) {
          owner.pages.push(pp);
          owner.foundBy.add("lookup");
        }
      }
    }
  } else if (needLookup.length > 0) {
    notes.push(`${needLookup.length} publication authors have no profile check because Exa is not configured.`);
  }

  // 5b. Topic-led only: expand to a few more organizations when the pool of people with
  //     a readable profile is thin. The search budget is MAX_SITE_SEARCHES in total.
  const readable = () => people.filter((p) => p.pages.length > 0).length;
  const spare = shortlist.slice(FIRST_PASS_SITE_SEARCHES, FIRST_PASS_SITE_SEARCHES + EXPANSION_SITE_SEARCHES);
  if (topicLed && readable() < THIN_POOL && spare.length > 0) {
    const more = await siteSearch(
      institutionalQueries(facets, spare.map((o) => o.domain), { perDomain: 1, max: EXPANSION_SITE_SEARCHES }),
    );
    errors.push(...more.errors);
    const fresh = more.leads
      .map(asInstitutional)
      .filter((l) => isSafePublicUrl(l.url) && !isNoiseHost(hostOf(l.url)) && !byUrl.has(normalizeUrl(l.url)));
    const extra = await inspectUrls(fresh.map((l) => l.url));
    if (extra.parserError) errors.push({ source: "parser", message: extra.parserError });
    const freshByKey = new Map(fresh.map((l) => [normalizeUrl(l.url), l]));
    for (const l of fresh) leadsByKey.set(normalizeUrl(l.url), { ...l, sources: new Set(["institutional"]), queries: new Set([l.queryId]) });
    log(extra.fetchLog, extra.pages, () => "institutional", freshByKey);
    for (const { pp, key } of personPages(extra.pages)) {
      const person = find({ name: pp.name, orgs: pp.orgs, url: pp.url });
      if (!person.pages.some((x) => x.url === pp.url)) person.pages.push(pp);
      tag(person, key);
    }
    institutional.push(...fresh);
    notes.push(`Candidate pool was thin (${readable()} readable profiles), so ${spare.length} more organization${spare.length === 1 ? "" : "s"} got a site search.`);
  }

  // 6. Turn each person into a candidate with claims that carry URL + date.
  // Everything found, including leads cut by the inspection cap, so a trace can say why a URL never got read.
  const inspectedKeys = new Set([...leadsByKey.keys(), ...followMeta.keys()]);
  const discovered: DiscoveredLead[] = [
    ...[...byUrl.values()].map((l) => ({ url: l.url, title: l.title, source: [...l.sources].join("+"), inspected: inspectedKeys.has(normalizeUrl(l.url)) })),
    ...[...followMeta.values()].map((m) => ({ url: m.link.url, title: m.link.name, source: "directory", inspected: true })),
  ];
  const stateOrgNames = oa?.stateOrgNames ?? [];
  const candidates = people.map((p) => buildCandidate(p, req, stateOrgNames));
  // A profile hosted on an in-state organization's own domain (cs.brown.edu for Brown)
  // places the person there when no page printed an address. Only that state's org
  // domains count, so nothing from another state can be pulled in.
  if (req.state) {
    const inStateDomains = orgs.filter((o) => o.state === req.state).flatMap((o) => o.domains.map(registrableDomain));
    for (const c of candidates) {
      if (c.location.value) continue;
      const hit = c.profiles.find((p) => !p.provisional && p.institutional && inStateDomains.includes(registrableDomain(hostOf(p.url))));
      if (hit) {
        c.location = {
          value: req.state,
          status: "inferred",
          source: hit.url,
          retrievedAt: hit.retrievedAt,
          note: `Profile is on the website of an organization in ${stateName(req.state)}.`,
        };
      }
    }
  }
  // People the LLM recalled by name, then found on a real page: an expert-recall signal.
  for (const c of candidates) {
    if (c.profiles.some((p) => !p.provisional) && llm.people.some((n) => sameName(n, c.name))) c.foundBy.push("llm-named");
  }
  if (llm.people.length) notes.push(`LLM named ${llm.people.length} people; ${candidates.filter((c) => c.foundBy.includes("llm-named")).length} confirmed on a page.`);

  // 7. Per-path yield at each stage, so providers can be compared on real queries.
  const surfaced = (src: string) => candidates.filter((c) => c.foundBy.includes(src)).length;
  const logFor = (src: string) => leadLog.filter((e) => e.source === src);
  const stat = (source: string, leads: number): SourceStat => {
    const entries = logFor(source);
    return {
      source,
      leads,
      inspected: entries.filter((e) => e.fetch === "ok").length,
      people: surfaced(source),
      fetchFailed: entries.filter((e) => e.fetch === "failed").length,
      extractFailed: entries.filter((e) => e.fetch === "ok" && e.extraction !== "person" && e.extraction !== "directory").length,
      provisional: entries.filter((e) => e.extraction === "provisional").length,
    };
  };
  // Log entries are keyed by one source; count shared leads for every path that found them.
  for (const e of [...leadLog]) {
    const lead = leadsByKey.get(normalizeUrl(e.url));
    if (lead && lead.sources.size > 1) {
      for (const s of lead.sources) if (s !== e.source) leadLog.push({ ...e, source: s });
    }
  }
  const sources: SourceStat[] = [
    { source: "openalex", leads: oa?.uniqueAuthors ?? 0, inspected: 0, people: surfaced("openalex") },
    stat("exa-people", exaPeople.leads.length),
    stat("exa-web", exaWeb.leads.length),
    stat("brave", brave.leads.length),
    stat("llm", llmLeads.length),
    stat("institutional", institutional.length),
    stat("directory", followMeta.size),
  ];

  if (oa) notes.push(`OpenAlex: scanned ${oa.worksScanned} works, ${oa.uniqueAuthors} unique authors.`);
  if (oa?.topics.length) notes.push(`OpenAlex topic expansion: ${oa.topics.join("; ")}.`);
  notes.push(
    `Inspected ${first.pages.length + second.pages.length} pages; ${candidates.filter((c) => c.profiles.some((p) => !p.provisional)).length} people have a readable profile, ${candidates.filter((c) => c.profiles.length > 0 && c.profiles.every((p) => p.provisional)).length} are provisional.`,
  );

  return { candidates, errors, sources, notes, poolFull: oa?.poolFull ?? false, leadLog, discovered };
}

/* ---------- candidate assembly ---------- */

function buildCandidate(p: Person, req: SearchRequest, stateOrgNames: string[]): Candidate {
  const base = p.author;
  const pages = p.pages;

  const stage = deriveStage(pages);
  const { orgs: pageOrgs, questions: orgQuestions } = deriveOrgs(base?.organizations ?? [], pages);
  // A provisional lead names an organization, but only as an unverified clue.
  const orgs = [...pageOrgs];
  for (const pv of p.provisional) {
    if (pv.org && !orgs.some((o) => orgOverlap([o.name], [pv.org as string]))) {
      orgs.push({ name: pv.org, lab: null, status: "inferred", source: pv.url, retrievedAt: pv.retrievedAt });
    }
  }
  const location = deriveLocation(
    pages,
    orgs.map((o) => o.name),
    stateOrgNames,
    req.state,
    base?.location ?? unknownClaim("No location found yet."),
  );
  const focus = deriveFocus(pages);
  const profiles = [
    ...pages.map(toProfile),
    ...p.provisional.map((pv) => ({
      url: pv.url,
      retrievedAt: pv.retrievedAt,
      institutional: isInstitutionalHost(hostOf(pv.url)),
      name: pv.name,
      headline: pv.text.slice(0, 200),
      provisional: true,
    })),
  ];

  const excerpts = [
    ...pages.flatMap((pg) => (pg.focus ? [{ url: pg.url, text: pg.focus }] : [])),
    ...pages.filter((pg) => pg.headline).map((pg) => ({ url: pg.url, text: pg.headline })),
    ...p.provisional.map((pv) => ({ url: pv.url, text: pv.text, provisional: true })),
  ];

  const evidence: Evidence[] = [
    ...pages.slice(0, 3).map(webEvidence),
    ...p.provisional.slice(0, 2).map(
      (pv): Evidence => ({ type: "profile", label: pv.text.slice(0, 120) || `${pv.name} lead`, url: pv.url, date: pv.retrievedAt.slice(0, 10) }),
    ),
    ...(base?.evidence ?? []),
  ].slice(0, 6);

  const candidate: Candidate = {
    id: p.id,
    orcid: base?.orcid ?? null,
    openalexId: base?.openalexId ?? null,
    name: base?.name ?? p.name,
    organizations: orgs,
    stage,
    location,
    focus,
    fit:
      focus.value && focus.status === "verified"
        ? `Profile describes: ${focus.value}`
        : (base?.fit ?? `Found through a web search for "${req.query}". Research focus not confirmed.`),
    methods: base?.methods ?? [],
    evidence,
    opportunityChecks: base?.opportunityChecks ?? [],
    unresolvedQuestions: [],
    matchedQueries: [...p.queries],
    profiles,
    foundBy: [...p.foundBy],
    excerpts,
    score: 0, // set by scorePeople
    contact: deriveContact(base?.name ?? p.name, pages),
  };
  candidate.unresolvedQuestions = openQuestions({
    stage,
    location,
    organizations: orgs,
    profiles,
    extra: [
      ...orgQuestions,
      ...(p.provisional.length && pages.length === 0 ? ["Only a search result or directory entry was read; the page itself is not verified."] : []),
    ],
  });
  return candidate;
}

