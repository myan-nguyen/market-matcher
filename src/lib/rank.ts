import { looksLikePerson } from "@/lib/extract";
import { keyPhrases, keyTerms } from "@/lib/keyphrases";
import { hostMatchesOrg, orgOverlap } from "@/lib/identity";
import { hostOf } from "@/lib/leads";
import { classify } from "@/lib/matching";
import {
  MAX_RESULTS,
  type Candidate,
  type Facets,
  type QueryPlan,
  type ScoreComponent,
  type SearchRequest,
} from "@/types/search";

/** Below this the match is weak and the list is allowed to end early. */
export const MIN_SCORE = 8;

const STOP = new Set([
  "the", "and", "for", "with", "who", "that", "this", "from", "into", "are", "use",
  "using", "their", "researchers", "researcher", "research", "studying", "people",
]);

export function terms(s: string): string[] {
  return [
    ...new Set(
      s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 4 && !STOP.has(t) && !t.startsWith("research") && !t.startsWith("stud")),
    ),
  ];
}

/**
 * Whole-word match allowing inflections only: "network" matches "networks" and
 * "networking", but "computer" does not match "computational".
 */
const hit = (hay: string, t: string) => {
  const stem = t.slice(0, Math.max(4, t.length - 3));
  return hay.split(/[^a-z0-9]+/).some((w) => w.startsWith(stem) && w.length <= t.length + 3);
};

/** Term weights. Defaults to 1; scoring passes IDF weights learned from the candidate pool. */
export type Weights = Map<string, number>;
export const share = (hay: string, ts: string[], w?: Weights) => {
  const total = ts.reduce((s, t) => s + (w?.get(t) ?? 1), 0);
  return total === 0 ? 0 : ts.filter((t) => hit(hay, t)).reduce((s, t) => s + (w?.get(t) ?? 1), 0) / total;
};

/**
 * Inverse document frequency over the candidate pool: a word that appears in
 * almost every candidate ("systems", "computer") carries little signal; a
 * distinctive one ("networking") carries most of it. No word list needed.
 */
export function idf(texts: string[], ts: string[]): Weights {
  const n = texts.length || 1;
  return new Map(ts.map((t) => [t, Math.log(1 + n / (1 + texts.filter((x) => hit(x, t)).length))]));
}

const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))];

/** Text read from a profile page or an institutional directory: direct evidence. */
function directText(c: Candidate): string {
  return [
    c.focus.value ?? "",
    ...(c.excerpts ?? []).filter((x) => !x.provisional).map((x) => x.text),
    ...c.profiles.filter((p) => !p.provisional).map((p) => p.headline),
  ]
    .join(" ")
    .toLowerCase();
}

/** Text from search snippets and directory entries that no page has confirmed. */
function leadText(c: Candidate): string {
  return (c.excerpts ?? []).filter((x) => x.provisional).map((x) => x.text).join(" ").toLowerCase();
}

/** Paper titles and ORCID/OpenAlex labels. Broad evidence: it shows activity, not focus. */
function paperText(c: Candidate): string {
  return c.evidence.filter((e) => e.type !== "profile").map((e) => e.label).join(" ").toLowerCase();
}

const allText = (c: Candidate) => `${directText(c)} ${leadText(c)} ${paperText(c)} ${c.methods.join(" ").toLowerCase()}`;

/** Topic terms from the request: content words of its noun phrases, not glue words. */
export function specificTopic(f: Facets): string[] {
  const k = keyTerms(f.topic).filter((t) => terms(t).length > 0);
  return k.length ? k : terms(f.topic);
}

/**
 * Share of the query's key phrases ("extracellular vesicles", "cancer cells") that a
 * text contains as a whole. Matching every word of a phrase is stronger evidence than
 * matching scattered words, so this rewards the actual subject over loose overlap.
 */
function phraseShare(hay: string, phrases: string[]): number {
  if (!phrases.length) return 0;
  const full = phrases.filter((p) => p.split(" ").every((w) => w.length < 4 || hit(hay, w)));
  // Longer phrases are more specific, so they count more.
  const weight = (p: string) => p.split(" ").length;
  return full.reduce((s, p) => s + weight(p), 0) / phrases.reduce((s, p) => s + weight(p), 0);
}

/* ---------- affiliation ---------- */

/** True when a source ties this person to the named institution. */
function affiliatedWith(c: Candidate, f: Facets): { ok: boolean; verified: boolean } {
  if (!f.institution) return { ok: true, verified: false };
  const inst = f.institution;
  const hosts = [...c.profiles.map((p) => hostOf(p.url)), ...c.evidence.map((e) => hostOf(e.url))];
  const onSite = hosts.some((h) => inst.domains.some((d) => h === d || h.endsWith(`.${d}`)));
  const named = c.organizations.some((o) => orgOverlap([o.name], [inst.name]) || hostMatchesOrg(o.name, [inst.name]));
  const verified =
    c.organizations.some((o) => o.status === "verified" && orgOverlap([o.name], [inst.name])) ||
    c.profiles.some((p) => !p.provisional && p.institutional && inst.domains.some((d) => hostOf(p.url) === d || hostOf(p.url).endsWith(`.${d}`)));
  return { ok: onSite || named, verified };
}

/* ---------- stage: verifyClaims ---------- */

/**
 * Minimum quality plus Dan's selected filters.
 *  - needs an identifiable name (first and last)
 *  - needs a source: a profile, a directory entry, a search result or a paper.
 *    A provisional source is allowed in, then ranked below read pages.
 *  - needs a connection to the topic (specific terms or related concepts), not a
 *    verbatim phrase match
 *  - a named institution must appear in an organization or on the person's pages
 *  - a verified mismatch on a selected state or stage excludes the person.
 * Unknown stage or location is kept and later shown as Needs review.
 */
export function verifyClaims(
  people: Candidate[],
  req: SearchRequest,
  plan: QueryPlan,
  facets: Facets,
  drops: Record<string, number> = {},
  why: Map<string, string> = new Map(),
): Candidate[] {
  // Topic does not filter here; it only ranks (see scorePeople).
  let current = "";
  const drop = (reason: string) => {
    drops[reason] = (drops[reason] ?? 0) + 1;
    why.set(current, reason);
    return false;
  };
  return people.filter((c) => {
    current = c.id;
    if (c.name.trim().split(/\s+/).length < 2) return drop("no full name");
    // A name from an author record or a page parsed as a person is structured data;
    // only names lifted from snippets or directory links need the free-text check.
    const structured = Boolean(c.openalexId || c.orcid) || c.profiles.some((p) => !p.provisional);
    if (!looksLikePerson(c.name, !structured)) return drop("not a person (program, unit or page name)");
    if (c.evidence.length === 0 && c.profiles.length === 0) return drop("no source page or paper");
    if (facets.institution && !affiliatedWith(c, facets).ok) return drop(`no tie to ${facets.institution.name}`);
    // Topic is not a gate: indirectly relevant people are kept and ranked by fit.
    const hay = `${c.name} ${allText(c)}`;
    if (plan.postFilters.exclude.some((t) => hay.includes(t.toLowerCase()))) return drop("matched an exclude term");
    // A stage filter is a hard requirement: the stage must have been read from one of
    // the person's own pages. Unknown or conflicting stages are not guessed in.
    if (req.stages.length && !(c.stage.value && req.stages.includes(c.stage.value) && (c.stage.status === "verified" || c.stage.status === "inferred"))) {
      return drop(c.stage.value ? "verified state/stage mismatch" : "stage not stated on any page");
    }
    return classify(c, req) !== "excluded" || drop("verified state/stage mismatch");
  });
}

/* ---------- stage: scorePeople ---------- */

function breakdown(c: Candidate, req: SearchRequest, plan: QueryPlan, f: Facets, w: Weights): ScoreComponent[] {
  const profileUrls = c.profiles.filter((p) => !p.provisional).map((p) => p.url);
  const leadUrls = c.profiles.filter((p) => p.provisional).map((p) => p.url);
  const evidenceUrls = c.evidence.map((e) => e.url);
  const allUrls = uniq([...profileUrls, ...leadUrls, ...evidenceUrls]);

  const core = specificTopic(f);
  const relatedTerms = f.related.flatMap((r) => terms(r));
  const cohortTerms = f.cohort ? terms(f.cohort).filter((t) => !core.includes(t)) : [];
  const soft = terms([...plan.ranking.prefer, plan.ranking.method ?? ""].join(" "));

  const direct = directText(c);
  const leads = leadText(c);
  const papers = paperText(c);

  // 50: fit of documented work. The specific topic is matched in each source tier,
  // with direct page evidence worth far more than a snippet or a paper title.
  // Counts of papers and citations are never used here.
  const phrases = keyPhrases(f.topic);
  const mix = (hay: string) => {
    const s = share(hay, core, w);
    return phrases.length > 1 ? 0.6 * s + 0.4 * phraseShare(hay, phrases) : s;
  };
  const topicDirect = mix(direct);
  const topicLead = mix(leads);
  const topicPaper = mix(papers);
  // Prominence: is the topic what the person is *about* (focus line, page headline,
  // most of their papers) or only mentioned once? A neuroscientist's headline and
  // most papers name the field; a methods person has one paper that does.
  const primary = `${c.focus.value ?? ""} ${c.profiles.filter((p) => !p.provisional).map((p) => p.headline).join(" ")}`.toLowerCase();
  const paperRows = c.evidence.filter((e) => e.type !== "profile");
  const paperShare = paperRows.length
    ? paperRows.filter((e) => share(e.label.toLowerCase(), core, w) > 0).length / paperRows.length
    : 0;
  const topicPrimary = share(primary, core, w);
  const topicFit = Math.max(
    topicDirect * (0.7 + 0.3 * topicPrimary),
    topicLead * 0.6,
    topicPaper * (0.2 + 0.3 * paperShare),
  );
  // Related, cohort and preference terms are softer. They only count when the core
  // topic itself was found in a page or snippet, never from a paper title alone, so
  // broad overlap ("accessible", "algorithmic") cannot lift someone with no direct topic evidence.
  const coreDirect = topicDirect > 0 || topicLead > 0;
  const soften = coreDirect ? 1 : 0;
  const relatedFit = Math.max(share(direct, relatedTerms), share(leads, relatedTerms) * 0.6, share(papers, relatedTerms) * 0.35);
  const fit =
    topicFit * 38 +
    (relatedTerms.length ? relatedFit * 6 : 0) * soften +
    share(`${direct} ${leads} ${papers}`, cohortTerms) * 3 * soften +
    share(`${direct} ${leads} ${papers}`, soft) * 3 * soften +
    // Named by the LLM as a known expert on this topic and confirmed on a real page.
    // Directory pages are terse ("Research Areas: Networking"), so this stands in for
    // the field knowledge a chat assistant uses to rank well-known people first.
    (c.foundBy.includes("llm-named") ? 12 : 0);

  // 20: evidence the person does the work. A profile or page describing it counts
  // most; a paper title adds a little; a bare search result adds almost nothing.
  const paperList = c.evidence.filter((e) => e.type !== "profile");
  const described = profileUrls.length > 0 && topicDirect > 0;
  const personal =
    (described ? 14 : 0) +
    (topicLead > 0 && !described ? 4 : 0) +
    (topicPaper > 0 ? Math.min(paperList.length, 3) * 2 : 0);

  // 15: a current profile supporting identity, organization, and selected stage/location.
  const institutional = c.profiles.filter((p) => p.institutional && !p.provisional);
  const aff = affiliatedWith(c, f);
  const selected: boolean[] = [];
  if (req.state) selected.push(c.location.status === "verified" && c.location.value === req.state);
  if (req.stages.length) {
    selected.push(c.stage.status === "verified" && !!c.stage.value && req.stages.includes(c.stage.value));
  }
  // A verified match earns full credit; an inferred one (publication affiliation,
  // personal site) earns half, so location still ranks people whose page does not say it.
  if (req.state) {
    const l = c.location;
    selected[0] = l.value === req.state && (l.status === "verified" || l.status === "inferred");
  }
  const locVerified = req.state ? c.location.status === "verified" && c.location.value === req.state : true;
  const constraintShare = selected.length
    ? selected.reduce((s, ok, i) => s + (ok ? (i === 0 && req.state && !locVerified ? 0.5 : 1) : 0), 0) / selected.length
    : profileUrls.length ? 1 : 0;
  const locWeight = req.state || f.institution ? 8 : 5;
  const orgVerified = c.organizations.some((o) => o.status === "verified");
  const profile =
    (profileUrls.length ? 4 : 0) +
    (institutional.length ? 3 : 0) +
    (orgVerified || aff.verified ? 3 : 0) +
    constraintShare * locWeight;

  // 10: recent evidence. Pages read today count as current.
  const year = new Date().getFullYear();
  const dated = c.evidence.map((e) => ({ y: Number(e.date.slice(0, 4)) || 0, url: e.url }));
  const newest = Math.max(0, ...dated.map((d) => d.y));
  const recent = newest ? Math.max(0, 1 - (year - newest) / 8) * 7 : 0;

  // 5: independent hosts that support the same person.
  const hosts = uniq(allUrls.map(hostOf));
  const corroboration = hosts.length >= 2 ? (Math.min(hosts.length, 3) - 1) * 2.5 : 0;

  const r = (n: number) => Math.round(n * 10) / 10;
  return [
    { key: "fit", label: "Fit to search and cohort", points: r(Math.min(fit, 50)), max: 50, urls: allUrls },
    { key: "personal", label: "Personally does the work", points: r(personal), max: 20, urls: uniq([...(described ? profileUrls : []), ...paperList.map((e) => e.url)]) },
    { key: "profile", label: "Current profile supports identity", points: r(profile), max: 18, urls: profileUrls },
    { key: "recent", label: "Recent evidence", points: r(recent), max: 7, urls: dated.filter((d) => d.y === newest && newest > 0).map((d) => d.url) },
    { key: "corroboration", label: "Independent corroboration", points: r(corroboration), max: 5, urls: hosts.length >= 2 ? allUrls : [] },
  ];
}

export function scorePeople(people: Candidate[], req: SearchRequest, plan: QueryPlan, facets: Facets): Candidate[] {
  const core = specificTopic(facets);
  const w = idf(people.map(allText), core);
  // The cohort names the field the person should belong to ("neuroscience researchers").
  // A topic word that is also in the cohort defines identity, so it outweighs a word
  // that is merely rarer ("neurons" in a computational paper).
  const cohort = facets.cohort ? terms(facets.cohort) : [];
  for (const t of core) if (cohort.some((c) => hit(t, c) || hit(c, t))) w.set(t, (w.get(t) ?? 1) * 2.5);
  return people
    .map((c) => {
      const k = placeFactor(c, req) * topicFactor(c, core, w) * stagePrior(c, req);
      const scoreBreakdown = breakdown(c, req, plan, facets, w).map((s) => ({ ...s, points: Math.round(s.points * k * 10) / 10 }));
      const score = Math.round(scoreBreakdown.reduce((s, x) => s + x.points, 0) * 10) / 10;
      return { ...c, score, scoreBreakdown };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Location is a strong ranking signal when a state was chosen: a verified match keeps
 * the full score, an unconfirmed one keeps most, and a person placed in another state
 * (even by inference) falls well below every local match.
 */
function placeFactor(c: Candidate, req: SearchRequest): number {
  if (!req.state) return 1;
  const l = c.location;
  if (l.value === req.state) return l.status === "verified" ? 1 : 0.9;
  if (l.value && l.value !== req.state) return 0.35;
  return 0.6;
}

/**
 * With no stage filter, the default audience is established researchers: PIs/faculty
 * and postdocs keep full weight, a confirmed student is slightly below, and an
 * unknown stage sits between. A selected stage filter overrides this entirely.
 */
function stagePrior(c: Candidate, req: SearchRequest): number {
  if (req.stages.length) return 1;
  const s = c.stage.value;
  if (s === "faculty" || s === "postdoc") return 1;
  if (s === "advanced-phd" || s === "early-phd") return 0.85;
  return 0.92;
}

/** People with no topic evidence on a page or snippet rank below anyone who has it. */
function topicFactor(c: Candidate, core: string[], w: Weights): number {
  if (!core.length) return 1;
  const onPage = share(`${directText(c)} ${leadText(c)}`, core, w);
  if (onPage > 0 || c.foundBy.includes("llm-named")) return 1;
  return share(paperText(c), core, w) > 0 ? 0.7 : 0.45;
}

/* ---------- stage: selectTop50 ---------- */

/**
 * The 50 most relevant people, diversified across organizations. Each extra person
 * from an organization already in the list is discounted (0.85^k) when choosing the
 * next slot, so one university cannot fill the page unless its people are clearly
 * stronger. Scores themselves are unchanged; only the selection order is.
 */
const ORG_DECAY = 0.85;

function orgKey(c: Candidate): string | null {
  const o = c.organizations.find((x) => x.status === "verified") ?? c.organizations[0];
  if (o) return o.name.toLowerCase().replace(/^the\s+/, "").trim();
  const inst = c.profiles.find((p) => p.institutional);
  return inst ? hostOf(inst.url).split(".").slice(-2).join(".") : null;
}

export function selectTop50(scored: Candidate[], req?: SearchRequest): { selected: Candidate[]; capped: boolean } {
  // With a state selected, diversity never crosses location tiers: every in-state
  // person comes before anyone with an unknown location, who comes before anyone
  // placed in another state. Spreading across organizations happens within a tier.
  const tier = (c: Candidate) => {
    if (!req?.state) return 0;
    if (c.location.value === req.state) return 0;
    return c.location.value ? 2 : 1;
  };
  const pool = [...scored];
  const used = new Map<string, number>();
  const selected: Candidate[] = [];
  while (selected.length < MAX_RESULTS && pool.length) {
    let best = 0;
    let bestTier = Infinity;
    let bestVal = -Infinity;
    pool.forEach((c, i) => {
      const t = tier(c);
      const k = orgKey(c);
      const v = c.score * ORG_DECAY ** (k ? used.get(k) ?? 0 : 0);
      if (t < bestTier || (t === bestTier && v > bestVal)) [best, bestTier, bestVal] = [i, t, v];
    });
    const [c] = pool.splice(best, 1);
    const k = orgKey(c);
    if (k) used.set(k, (used.get(k) ?? 0) + 1);
    selected.push(c);
  }
  return { selected, capped: scored.length > MAX_RESULTS };
}
