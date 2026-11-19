// Contract between the page and the server. Keep this file free of UI code.

export const MAX_RESULTS = 50;

export const STAGE_CODES = ["postdoc", "advanced-phd", "early-phd", "faculty"] as const;
export type StageCode = (typeof STAGE_CODES)[number];

export const STAGE_LABELS: Record<StageCode, string> = {
  postdoc: "Postdoc",
  "advanced-phd": "Advanced PhD",
  "early-phd": "Early PhD",
  faculty: "Faculty",
};

/**
 * verified    = read from a current institutional page naming this person
 * inferred    = deduced (publication affiliation, personal site, ambiguous wording)
 * unknown     = not found
 * conflicting = sources disagree
 * Anything other than "verified" is shown as Needs verification.
 */
export type ClaimStatus = "verified" | "inferred" | "unknown" | "conflicting";

export type Claim<T> = {
  value: T | null; // null when unknown or conflicting
  status: ClaimStatus;
  source: string | null; // URL the claim was read from
  retrievedAt: string | null; // ISO timestamp of that retrieval
  note: string | null; // why it has this status
};

/* ---------- Request ---------- */

export type SearchRequest = {
  query: string; // main phrase (required)
  cohort: string; // free-text cohort (required)
  include: string[]; // explicit only
  prefer: string[];
  exclude: string[];
  method: string | null;
  state: string | null; // two-letter code, null = no state constraint
  stages: StageCode[]; // empty = no stage constraint
  trace?: string[]; // names or URL fragments to follow through every pipeline stage
};

/* ---------- Candidate ---------- */

export type EvidenceType = "profile" | "publication" | "project";

export type Evidence = {
  type: EvidenceType;
  label: string;
  url: string;
  date: string; // ISO date
};

export type OpportunityStatus = "checked" | "unresolved" | "not checked";

export type OpportunityCheck = {
  label: string;
  status: OpportunityStatus;
  note: string | null;
};

export type Organization = {
  name: string;
  lab: string | null;
  status: ClaimStatus;
  source: string | null;
  retrievedAt: string | null;
};

/** A public page that was fetched and parsed for this person. */
export type InspectedProfile = {
  url: string;
  retrievedAt: string;
  institutional: boolean; // .edu / .gov / .ac.* host
  name: string | null;
  headline: string;
  provisional?: boolean; // built from search-result text because the page was not readable
};

/** Text that describes a person's work, read from a page or a search result. */
export type Excerpt = { url: string; text: string; provisional?: boolean };

export type Candidate = {
  id: string; // stable across searches
  orcid: string | null; // bare ORCID iD, used to merge records
  openalexId: string | null; // e.g. A5012345678, used to merge records
  name: string;
  organizations: Organization[];
  stage: Claim<StageCode>;
  location: Claim<string>; // state code
  focus: Claim<string>; // research focus, as the profile words it
  fit: string; // why this person fits the typed cohort
  methods: string[];
  evidence: Evidence[];
  opportunityChecks: OpportunityCheck[];
  unresolvedQuestions: string[];
  matchedQueries: string[]; // ids of the retrieval queries that found this person
  profiles: InspectedProfile[]; // pages inspected for this person
  foundBy: string[]; // discovery paths that surfaced this person
  excerpts?: Excerpt[]; // direct text from profile pages or search results, with its URL
  score: number; // 0-100 after scoring; the sum of scoreBreakdown
  scoreBreakdown?: ScoreComponent[]; // set by scorePeople
};

/** One part of the 100-point rubric, with the URLs that earned it. */
export type ScoreComponent = {
  key: "fit" | "personal" | "profile" | "recent" | "corroboration";
  label: string;
  points: number;
  max: number;
  urls: string[];
};

/* ---------- Response ---------- */

export type SourceError = {
  source: string;
  message: string;
};

/** One retrieval call. Each form input maps to a role, not to one long phrase. */
export type RetrievalQuery = {
  id: string;
  kind: "discovery" | "include";
  text: string;
  stateFilter: string | null; // pushed into the source query when supported
  reason: string;
};

export type QueryPlan = {
  queries: RetrievalQuery[]; // run independently, then merged by person
  ranking: { prefer: string[]; method: string | null }; // influence order only
  postFilters: { exclude: string[] }; // applied after retrieval
  enrichment: { stages: StageCode[] }; // checked against profiles, not APIs
  steps: string[];
  appliedConstraints: string[]; // only what the user explicitly added
};

/** Per-path yield, so providers can be compared (for example Exa against Brave). */
export type SourceStat = {
  source: string;
  leads: number; // URLs or authors returned
  inspected: number; // pages fetched and parsed from this path
  people: number; // candidates this path surfaced before verification
  fetchFailed?: number; // leads whose page could not be fetched
  extractFailed?: number; // pages fetched but no person could be read
  provisional?: number; // leads kept as provisional people
  passed?: number; // people from this path that passed verification
  selected?: number; // people from this path in the final list
};

/** The query split into independent parts. Nothing here is required verbatim. */
export type Facets = {
  topic: string; // core research topic
  cohort: string; // cohort text when it adds to the topic
  related: string[]; // related concepts: include, prefer, method
  institution: { name: string; domains: string[]; openalexId?: string } | null; // required affiliation
  state: string | null;
  stages: StageCode[];
};

export type LeadLogEntry = {
  url: string;
  source: string;
  fetch: "ok" | "failed" | "skipped";
  extraction: "person" | "directory" | "provisional" | "other" | "error" | "none";
  reason: string | null;
};

export type ProviderLimitStat = {
  provider: string;
  requests: number;
  rateLimited: number;
  retries: number;
  cacheHits: number;
  failures: number;
};

/** A lead as first seen, before any inspection cap was applied. */
export type DiscoveredLead = { url: string; title: string | null; source: string; inspected: boolean };

export type TraceStage = "discovered" | "fetched" | "extracted" | "verified" | "scored" | "selected";
export type TraceStep = { stage: TraceStage; ok: boolean; detail: string };
/** One traced name or URL: where it went through the pipeline and why it stopped. */
export type TraceRow = { term: string; steps: TraceStep[]; stoppedAt: TraceStage | null };

export type Diagnostics = {
  trace: TraceRow[];
  facets: Facets;
  leadLog: LeadLogEntry[];
  rejections: Record<string, number>; // people dropped by verification, by reason
  rateLimits: ProviderLimitStat[];
};

export type SearchResponse = {
  candidates: Candidate[];
  diagnostics: Diagnostics;
  sources: SourceStat[];
  queryPlan: QueryPlan;
  sourceErrors: SourceError[];
  retrievedAt: string; // ISO timestamp
  limitReached: boolean; // true when MAX_RESULTS was hit
};

/* ---------- Result-side controls (client only) ---------- */

export type MatchGroup = "verified" | "needs-checking";
export type SortKey = "strongest" | "newest" | "name";

export type ResultFilters = {
  group: MatchGroup; // only used when a state or stage was selected
  stageStatus: "all" | ClaimStatus;
  stage: "all" | StageCode | "unknown";
  institution: "all" | string;
  evidenceType: "all" | EvidenceType;
  opportunity: "all" | OpportunityStatus;
  sort: SortKey;
};

export const DEFAULT_FILTERS: ResultFilters = {
  group: "verified",
  stageStatus: "all",
  stage: "all",
  institution: "all",
  evidenceType: "all",
  opportunity: "all",
  sort: "strongest",
};
