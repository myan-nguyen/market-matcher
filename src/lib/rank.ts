import { looksLikePerson } from "@/lib/extract";
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
  return [...new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 4 && !STOP.has(t)))];
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

/** Topic terms from the request. Their relative weight comes from IDF at scoring time. */
export function specificTopic(f: Facets): string[] {
  return terms(f.topic);
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
    if (!looksLikePerson(c.name)) return drop("not a person (program, unit or page name)");
    if (c.evidence.length === 0 && c.profiles.length === 0) return drop("no source page or paper");
    if (facets.institution && !affiliatedWith(c, facets).ok) return drop(`no tie to ${facets.institution.name}`);
    // Topic is not a gate: indirectly relevant people are kept and ranked by fit.
    const hay = `${c.name} ${allText(c)}`;
    if (plan.postFilters.exclude.some((t) => hay.includes(t.toLowerCase()))) return drop("matched an exclude term");
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
  const topicDirect = share(direct, core, w);
  const topicLead = share(leads, core, w);
  const topicPaper = share(papers, core, w);
  const topicFit = Math.max(topicDirect * 1, topicLead * 0.6, topicPaper * 0.35);
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
    share(`${direct} ${leads} ${papers}`, soft) * 3 * soften;

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
  const constraintShare = selected.length ? selected.filter(Boolean).length / selected.length : profileUrls.length ? 1 : 0;
  const orgVerified = c.organizations.some((o) => o.status === "verified");
  const profile =
    (profileUrls.length ? 4 : 0) +
    (institutional.length ? 3 : 0) +
    (orgVerified || aff.verified ? 3 : 0) +
    constraintShare * 5;

  // 10: recent evidence. Pages read today count as current.
  const year = new Date().getFullYear();
  const dated = c.evidence.map((e) => ({ y: Number(e.date.slice(0, 4)) || 0, url: e.url }));
  const newest = Math.max(0, ...dated.map((d) => d.y));
  const recent = newest ? Math.max(0, 1 - (year - newest) / 8) * 10 : 0;

  // 5: independent hosts that support the same person.
  const hosts = uniq(allUrls.map(hostOf));
  const corroboration = hosts.length >= 2 ? (Math.min(hosts.length, 3) - 1) * 2.5 : 0;

  const r = (n: number) => Math.round(n * 10) / 10;
  return [
    { key: "fit", label: "Fit to search and cohort", points: r(fit), max: 50, urls: allUrls },
    { key: "personal", label: "Personally does the work", points: r(personal), max: 20, urls: uniq([...(described ? profileUrls : []), ...paperList.map((e) => e.url)]) },
    { key: "profile", label: "Current profile supports identity", points: r(profile), max: 15, urls: profileUrls },
    { key: "recent", label: "Recent evidence", points: r(recent), max: 10, urls: dated.filter((d) => d.y === newest && newest > 0).map((d) => d.url) },
    { key: "corroboration", label: "Independent corroboration", points: r(corroboration), max: 5, urls: hosts.length >= 2 ? allUrls : [] },
  ];
}

export function scorePeople(people: Candidate[], req: SearchRequest, plan: QueryPlan, facets: Facets): Candidate[] {
  const w = idf(people.map(allText), specificTopic(facets));
  return people
    .map((c) => {
      const scoreBreakdown = breakdown(c, req, plan, facets, w);
      const score = Math.round(scoreBreakdown.reduce((s, x) => s + x.points, 0) * 10) / 10;
      return { ...c, score, scoreBreakdown };
    })
    .sort((a, b) => b.score - a.score);
}

/* ---------- stage: selectTop50 ---------- */

/** The 50 most relevant verified people. Relevance orders the list; it does not empty it. */
export function selectTop50(scored: Candidate[]): { selected: Candidate[]; capped: boolean } {
  return { selected: scored.slice(0, MAX_RESULTS), capped: scored.length > MAX_RESULTS };
}
