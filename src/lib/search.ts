import { isStateCode } from "@/lib/states";
import { generateMockCandidates } from "@/lib/mockCandidates";
import {
  MAX_RESULTS,
  STAGE_CODES,
  type Candidate,
  type DiscoveredLead,
  type LeadLogEntry,
  type ProviderLimitStat,
  type SearchRequest,
  type SearchResponse,
  type SourceError,
  type SourceStat,
  type StageCode,
} from "@/types/search";
import { buildQueryPlan } from "@/lib/queryPlan";
import { discoverPeople } from "@/lib/discover";
import { parseFacets } from "@/lib/facets";
import { loadOrganizations, resolveNamedOrganization, type OrgRecord } from "@/lib/orgs";
import { errMessage } from "@/lib/pool";
import { exaQueue } from "@/lib/providers/exa";
import { resolveIdentities } from "@/lib/resolve";
import { MIN_SCORE, verifyClaims, scorePeople, selectTop50 } from "@/lib/rank";
import { buildTrace } from "@/lib/trace";

function isStage(v: string): v is StageCode {
  return (STAGE_CODES as readonly string[]).includes(v);
}

/** Validates an untrusted request body. Returns null if main phrase or cohort is missing. */
export function parseRequest(body: unknown): SearchRequest | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const list = (v: unknown) =>
    Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean)
      : [];

  const query = str(b.query);
  const cohort = str(b.cohort);
  if (!query || !cohort) return null;

  const state = str(b.state).toUpperCase();
  return {
    query,
    cohort,
    include: list(b.include),
    prefer: list(b.prefer),
    exclude: list(b.exclude),
    method: str(b.method) || null,
    state: isStateCode(state) ? state : null,
    stages: list(b.stages).filter(isStage),
    trace: list(b.trace),
  };
}

/**
 * Pipeline, one stage per step:
 * parseFacets -> retrieveLeads -> resolvePeople -> verifyClaims -> scorePeople -> selectTop50
 */
export async function runSearch(req: SearchRequest): Promise<SearchResponse> {
  const plan = buildQueryPlan(req);
  const sourceErrors: SourceError[] = [];
  let leads: Candidate[] = [];
  let sources: SourceStat[] = [];
  let leadLog: LeadLogEntry[] = [];
  let discovered: DiscoveredLead[] = [];
  let notes: string[] = [];
  let poolFull = false;
  const exaBefore = exaQueue.snapshot();

  // 0. parseFacets: topic, named institution, geography, stage. Nothing is matched verbatim.
  let orgs: OrgRecord[] = [];
  try {
    orgs = await loadOrganizations(req.state);
  } catch (e) {
    sourceErrors.push({ source: "organizations", message: errMessage(e) });
  }
  let facets = parseFacets(req, orgs);
  if (facets.institution && !facets.institution.openalexId) {
    const named = await resolveNamedOrganization(facets.institution.name, req.state).catch(() => null);
    if (named) {
      facets = { ...facets, institution: { name: named.name, domains: named.domains, openalexId: named.ids.openalex } };
      orgs = [...orgs, named];
    }
  }

  // 1. retrieveLeads: OpenAlex, people search, institutional and web pages.
  if (process.env.USE_MOCK_SEARCH === "1") {
    leads = generateMockCandidates(req, MAX_RESULTS + 10);
    notes = ["Mock data (USE_MOCK_SEARCH=1)"];
  } else {
    const out = await discoverPeople(req, plan, facets, orgs);
    leads = out.candidates;
    sources = out.sources;
    leadLog = out.leadLog;
    discovered = out.discovered;
    notes = out.notes;
    poolFull = out.poolFull;
    sourceErrors.push(...out.errors);
  }

  // 2. resolvePeople: ORCID / OpenAlex ID first, then full name plus organization.
  const resolved = resolveIdentities(leads);
  if (resolved.merged > 0) notes.push(`Merged ${resolved.merged} duplicate record${resolved.merged === 1 ? "" : "s"} by ORCID, OpenAlex ID, or full name plus organization.`);
  if (resolved.similar > 0) notes.push(`${resolved.similar} pair${resolved.similar === 1 ? "" : "s"} of similar names kept separate.`);

  // 3. verifyClaims: minimum quality, named institution, exclude terms, verified mismatches.
  const drops: Record<string, number> = {};
  const why = new Map<string, string>();
  const verified = verifyClaims(resolved.people, req, plan, facets, drops, why);
  const dropped = Object.entries(drops).map(([why, n]) => `${n} ${why}`);
  notes.push(`Found ${resolved.people.length} people; ${verified.length} passed checks.`);
  if (dropped.length) notes.push(`Dropped: ${dropped.join("; ")}.`);

  // 4. scorePeople: 100-point rubric, components stored on each person.
  const scored = scorePeople(verified, req, plan, facets);

  // 5. selectTop50: fewer than 50 when the rest are weak.
  const { selected, capped } = selectTop50(scored, req);

  // Per-source counts after verification and selection.
  const count = (list: Candidate[], src: string) => list.filter((c) => c.foundBy.includes(src)).length;
  sources = sources.map((s) => ({ ...s, passed: count(verified, s.source), selected: count(selected, s.source) }));

  const trace = buildTrace({
    terms: req.trace ?? [],
    discovered,
    leadLog,
    resolved: resolved.people,
    rejected: why,
    verified,
    scored,
    selected,
    minScore: MIN_SCORE,
  });

  const exa = exaQueue.snapshot();
  const rateLimits: ProviderLimitStat[] = [
    {
      provider: "exa",
      requests: exa.requests - exaBefore.requests,
      rateLimited: exa.rateLimited - exaBefore.rateLimited,
      retries: exa.retries - exaBefore.retries,
      cacheHits: exa.cacheHits - exaBefore.cacheHits,
      failures: exa.failures - exaBefore.failures,
    },
  ];
  if (rateLimits[0].rateLimited > 0) {
    notes.push(`Exa returned ${rateLimits[0].rateLimited} rate-limit response${rateLimits[0].rateLimited === 1 ? "" : "s"}; waited and retried ${rateLimits[0].retries} time${rateLimits[0].retries === 1 ? "" : "s"}.`);
  }

  return {
    candidates: selected,
    diagnostics: { trace, facets, leadLog, rejections: drops, rateLimits },
    sources,
    queryPlan: {
      ...plan,
      steps: [
        "parseFacets: topic, named institution, state and optional stage as separate parts",
        "retrieveLeads: OpenAlex, Exa People, institutional pages, directories, general web and Brave in parallel",
        "resolvePeople: merge by ORCID or OpenAlex ID, then full name plus organization",
        "verifyClaims: require a name, a source and the named institution; drop verified mismatches",
        "scorePeople: fit 50, personal work 20, current profile 15, recency 10, corroboration 5",
        "selectTop50: weak matches are left out",
        ...notes,
      ],
    },
    sourceErrors,
    retrievedAt: new Date().toISOString(),
    limitReached: capped || poolFull,
  };
}
