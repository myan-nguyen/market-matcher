import { hostOf, isInstitutionalHost, isNoiseHost, type Lead } from "@/lib/leads";
import { resolveNamedOrganization } from "@/lib/orgs";
import { share, specificTopic, terms } from "@/lib/rank";
import type { WebQuery } from "@/lib/webQueries";
import type { Candidate, Facets } from "@/types/search";

/**
 * Topic-led discovery. With no state and no institution, institutions are a way
 * to find people, not a prerequisite: a few organizations are chosen from what
 * the broad searches and OpenAlex already surfaced, and each gets one site search.
 */

export const FIRST_PASS_SITE_SEARCHES = 8;
export const EXPANSION_SITE_SEARCHES = 4;
export const MAX_SITE_SEARCHES = FIRST_PASS_SITE_SEARCHES + EXPANSION_SITE_SEARCHES;
export const THIN_POOL = 10; // fewer readable profiles than this triggers the expansion
const RESERVED_INDEPENDENT = 2; // places kept for independent research centers
const OA_ORG_LOOKUPS = 6;
const EVIDENCE_CAP = 3; // one institution cannot earn more than this from any signal
const CACHE_TTL_MS = 30 * 60_000;

export type OrgCandidate = { domain: string; name: string; independent: boolean; score: number };

export function broadQueries(topic: string): WebQuery[] {
  return [
    { id: "b1", text: `"${topic}" researcher faculty lab`, branch: "broad" },
    { id: "b2", text: `"${topic}" research center institute`, branch: "broad" },
  ];
}

/** brown.edu for cs.brown.edu; keeps three labels for hosts such as ox.ac.uk. */
export function registrableDomain(host: string): string {
  const h = host.replace(/^www\./, "");
  const n = /\.(?:ac|edu|co|org|gov|com)\.[a-z]{2}$/.test(h) ? 3 : 2;
  return h.split(".").slice(-n).join(".");
}

type Acc = { domain: string; name: string; independent: boolean; topicLeads: number; oaPeople: number };

const cache = new Map<string, { at: number; ordered: OrgCandidate[] }>();

/**
 * Ranks organizations by how many people show specific topic evidence, with each
 * signal capped per institution so publication volume cannot decide the order.
 * The first FIRST_PASS_SITE_SEARCHES entries are the initial shortlist, the rest
 * are held back for the expansion. Results are cached by topic.
 */
export async function shortlistOrgs(
  f: Facets,
  leads: Lead[],
  authors: Candidate[],
  resolve: typeof resolveNamedOrganization = resolveNamedOrganization,
): Promise<OrgCandidate[]> {
  const key = [f.topic, ...f.related].join("|").toLowerCase();
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.ordered;

  const topic = [...specificTopic(f), ...f.related.flatMap((r) => terms(r))];
  const topical = (text: string) => share(text.toLowerCase(), topic) > 0;
  const accs = new Map<string, Acc>();
  const touch = (domain: string, name: string, independent: boolean): Acc => {
    const a = accs.get(domain) ?? { domain, name, independent, topicLeads: 0, oaPeople: 0 };
    a.name = name.length > a.name.length && !name.includes(".") ? name : a.name;
    accs.set(domain, a);
    return a;
  };

  // Organizations named by the broad web results. Personal sites are skipped here
  // (their profiles are still inspected), so only institutional hosts and
  // independent centers can be selected.
  for (const l of leads) {
    const host = hostOf(l.url);
    if (!host || isNoiseHost(host)) continue;
    const text = `${l.title ?? ""} ${l.snippet ?? ""}`;
    const institutional = isInstitutionalHost(host);
    const independent = !institutional && /institute|\bcent(?:er|re)\b|laborator|\blab\b/i.test(`${text} ${host}`);
    if (!institutional && !independent) continue;
    const a = touch(registrableDomain(host), registrableDomain(host), independent);
    if (topical(text)) a.topicLeads++;
  }

  // Organizations named in OpenAlex affiliations, counted by authors whose work
  // matches the topic, then resolved to a website domain.
  const counts = new Map<string, number>();
  for (const c of authors) {
    const work = c.evidence.filter((e) => e.type !== "profile").map((e) => e.label).join(" ");
    if (!topical(work)) continue;
    for (const o of c.organizations) counts.set(o.name, (counts.get(o.name) ?? 0) + 1);
  }
  const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, OA_ORG_LOOKUPS);
  const resolved = await Promise.all(
    top.map(async ([name, n]) => ({ name, n, org: await resolve(name, null).catch(() => null) })),
  );
  for (const { name, n, org } of resolved) {
    const domain = org?.domains[0];
    if (!org || !domain) continue;
    const root = registrableDomain(domain);
    const a = touch(root, name, org.type !== "university" && !isInstitutionalHost(root));
    a.oaPeople += n;
  }

  const ranked: OrgCandidate[] = [...accs.values()]
    .map((a) => ({
      domain: a.domain,
      name: a.name,
      independent: a.independent,
      score: Math.min(a.topicLeads, EVIDENCE_CAP) * 2 + Math.min(a.oaPeople, EVIDENCE_CAP) * 2,
    }))
    .filter((o) => o.score > 0) // no specific topic evidence, no site search
    .sort((a, b) => b.score - a.score || a.domain.localeCompare(b.domain));

  const reserved = ranked.filter((o) => o.independent).slice(0, RESERVED_INDEPENDENT);
  const institutions = ranked.filter((o) => !o.independent).slice(0, FIRST_PASS_SITE_SEARCHES - reserved.length);
  const picked = new Set([...reserved, ...institutions].map((o) => o.domain));
  const fill = ranked.filter((o) => !picked.has(o.domain)).slice(0, FIRST_PASS_SITE_SEARCHES - picked.size);
  const first = [...reserved, ...institutions, ...fill].sort((a, b) => b.score - a.score);
  const inFirst = new Set(first.map((o) => o.domain));
  const ordered = [...first, ...ranked.filter((o) => !inFirst.has(o.domain))];

  cache.set(key, { at: Date.now(), ordered });
  return ordered;
}
