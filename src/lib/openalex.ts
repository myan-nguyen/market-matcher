import { errMessage, pool } from "@/lib/pool";
import { stateName } from "@/lib/states";
import { unknownClaim } from "@/lib/verify";
import type {
  Candidate,
  Evidence,
  Organization,
  QueryPlan,
  SearchRequest,
  SourceError,
} from "@/types/search";

const BASE = "https://api.openalex.org";
const PER_PAGE = 100; // supported maximum
const MAX_PAGES_PER_QUERY = 5; // 500 works per query, well under the 10,000 basic-paging cap
const CONCURRENCY = 4;
const INSTITUTION_PAGES = 4; // up to 400 institutions in a state
const EVIDENCE_PER_AUTHOR = 2;

/* ---------- minimal OpenAlex shapes (only the fields we select) ---------- */

type OAInstitution = { id: string; display_name: string; country_code: string | null };
type OAAuthorship = {
  author: { id: string; display_name: string; orcid: string | null };
  institutions: OAInstitution[];
};
type OAWork = {
  id: string;
  doi: string | null;
  display_name: string | null;
  publication_date: string | null;
  authorships: OAAuthorship[];
};
type OAList<T> = { meta: { count: number }; results: T[] };

const shortId = (id: string) => id.replace("https://openalex.org/", "");

/* ---------- HTTP ---------- */

async function oaFetch<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const key = process.env.OPENALEX_API_KEY?.trim();
  if (key) url.searchParams.set("api_key", key);
  const mailto = process.env.OPENALEX_MAILTO?.trim();
  if (mailto) url.searchParams.set("mailto", mailto);

  let lastError = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
    if (res.ok) return (await res.json()) as T;
    lastError = `HTTP ${res.status}`;
    if (res.status === 429 || res.status >= 500) {
      const ra = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 10_000) : 500 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if ((res.status === 401 || res.status === 403) && key) {
      throw new Error(`${lastError}: OpenAlex rejected OPENALEX_API_KEY. Check the key in .env.`);
    }
    const body = await res.text().catch(() => "");
    throw new Error(`${lastError} ${body.slice(0, 160)}`);
  }
  throw new Error(`${lastError} after retries${process.env.OPENALEX_API_KEY ? "" : " (set OPENALEX_API_KEY for a larger budget)"}`);
}

/* ---------- institutions in the selected state ---------- */

/** OpenAlex institution IDs whose geo.region is the selected state. */
export async function fetchStateInstitutions(stateCode: string): Promise<Map<string, string>> {
  const name = stateName(stateCode);
  if (!name) return new Map();
  const out = new Map<string, string>();
  for (let page = 1; page <= INSTITUTION_PAGES; page++) {
    const data = await oaFetch<OAList<{ id: string; display_name: string }>>("/institutions", {
      filter: `country_code:US,geo.region:"${name}"`,
      select: "id,display_name",
      per_page: String(PER_PAGE),
      page: String(page),
      sort: "works_count:desc",
    });
    for (const inst of data.results) out.set(shortId(inst.id), inst.display_name);
    if (data.results.length < PER_PAGE) break;
  }
  return out;
}

export type OAOrganization = {
  id: string;
  display_name: string;
  display_name_alternatives?: string[];
  ror?: string | null;
  type?: string | null;
  homepage_url?: string | null;
};

/** Full organization records for a state: universities, hospitals, companies, agencies, nonprofits. */
export async function fetchStateOrganizations(stateCode: string): Promise<OAOrganization[]> {
  const name = stateName(stateCode);
  if (!name) return [];
  const out: OAOrganization[] = [];
  for (let page = 1; page <= INSTITUTION_PAGES; page++) {
    const data = await oaFetch<OAList<OAOrganization>>("/institutions", {
      filter: `country_code:US,geo.region:"${name}"`,
      select: "id,display_name,display_name_alternatives,ror,type,homepage_url",
      per_page: String(PER_PAGE),
      page: String(page),
      sort: "works_count:desc",
    });
    out.push(...data.results);
    if (data.results.length < PER_PAGE) break;
  }
  return out;
}

/** Best OpenAlex match for a named institution, used when it is not in the seeded state list. */
export async function searchOrganization(name: string): Promise<OAOrganization | null> {
  const data = await oaFetch<OAList<OAOrganization>>("/institutions", {
    search: name,
    select: "id,display_name,display_name_alternatives,ror,type,homepage_url",
    per_page: "1",
  });
  return data.results[0] ?? null;
}

/* ---------- author accumulation ---------- */

type AuthorAcc = {
  id: string;
  name: string;
  orcid: string | null;
  orgs: Map<string, string>;
  inState: boolean;
  works: Map<string, Evidence>;
  queries: Set<string>;
};

export type OpenAlexOutcome = {
  candidates: Candidate[];
  errors: SourceError[];
  worksScanned: number;
  uniqueAuthors: number;
  poolFull: boolean;
  stateOrgNames: string[]; // institutions OpenAlex places in the selected state
};

/**
 * Runs each planned query against /works, pages until enough UNIQUE AUTHORS
 * are found (not papers), and dedupes by OpenAlex author ID.
 */
export async function searchOpenAlex(
  req: SearchRequest,
  plan: QueryPlan,
  target: number,
  requiredInstitutionId: string | null = null,
): Promise<OpenAlexOutcome> {
  const errors: SourceError[] = [];
  const regionName = stateName(req.state);

  // Resolve institution IDs first so authors can be tied to in-state organizations.
  let stateIds = new Map<string, string>();
  if (req.state) {
    try {
      stateIds = await fetchStateInstitutions(req.state);
      if (stateIds.size === 0) {
        errors.push({ source: "openalex:institutions", message: `No institutions found for ${regionName}.` });
      }
    } catch (e) {
      errors.push({ source: "openalex:institutions", message: errMessage(e) });
    }
  }
  const stateVerifiable = Boolean(req.state) && stateIds.size > 0;

  const authors = new Map<string, AuthorAcc>();
  let worksScanned = 0;
  let poolFull = false;

  function ingest(work: OAWork, queryId: string) {
    const evidence: Evidence = {
      type: "publication",
      label: work.display_name ?? "Untitled work",
      url: work.doi ?? work.id,
      date: work.publication_date ?? "",
    };
    for (const a of work.authorships) {
      if (!a.author?.id) continue;
      // Keep only affiliations that satisfy the explicit constraints.
      const eligible = a.institutions.filter((i) => {
        if (i.country_code !== "US") return false;
        if (requiredInstitutionId && shortId(i.id) !== requiredInstitutionId) return false;
        return stateVerifiable ? stateIds.has(shortId(i.id)) : true;
      });
      if (eligible.length === 0) continue;

      const id = shortId(a.author.id);
      let acc = authors.get(id);
      if (!acc) {
        acc = {
          id,
          name: a.author.display_name,
          orcid: a.author.orcid,
          orgs: new Map(),
          inState: false,
          works: new Map(),
          queries: new Set(),
        };
        authors.set(id, acc); // counted once, however many papers they have
      }
      for (const i of eligible) acc.orgs.set(shortId(i.id), i.display_name);
      if (stateVerifiable) acc.inState = true;
      acc.works.set(work.id, evidence);
      acc.queries.add(queryId);
    }
  }

  const tasks = plan.queries.map((q) => async () => {
    const filters = ["authorships.institutions.country_code:US"];
    if (requiredInstitutionId) filters.push(`authorships.institutions.id:${requiredInstitutionId}`);
    else if (regionName) filters.push(`authorships.institutions.geo.region:"${regionName}"`);

    for (let page = 1; page <= MAX_PAGES_PER_QUERY; page++) {
      if (authors.size >= target) {
        poolFull = true;
        return;
      }
      const data = await oaFetch<OAList<OAWork>>("/works", {
        search: q.text,
        filter: filters.join(","),
        select: "id,doi,display_name,publication_date,authorships",
        per_page: String(PER_PAGE),
        page: String(page),
      });
      worksScanned += data.results.length;
      for (const w of data.results) ingest(w, q.id);
      if (data.results.length < PER_PAGE) return; // query exhausted
    }
  });

  const settled = await pool(tasks, CONCURRENCY);
  settled.forEach((r, i) => {
    if (r.status === "rejected") {
      errors.push({
        source: `openalex:${plan.queries[i].id}`,
        message: errMessage(r.reason),
      });
    }
  });

  const now = new Date().toISOString();
  const candidates = [...authors.values()].map((a) => toCandidate(a, req, stateVerifiable, now));
  return {
    candidates,
    errors,
    worksScanned,
    uniqueAuthors: authors.size,
    poolFull,
    stateOrgNames: [...stateIds.values()],
  };
}

/* ---------- mapping to the shared Candidate contract ---------- */

function toCandidate(
  a: AuthorAcc,
  req: SearchRequest,
  stateVerifiable: boolean,
  now: string,
): Candidate {
  const works = [...a.works.values()].sort((x, y) => y.date.localeCompare(x.date));
  const newest = works[0];
  const profileUrl = a.orcid ?? `https://openalex.org/${a.id}`;

  const evidence: Evidence[] = [
    ...works.slice(0, EVIDENCE_PER_AUTHOR),
    {
      type: "profile",
      label: a.orcid ? "ORCID record" : "OpenAlex author record",
      url: profileUrl,
      date: newest?.date ?? "",
    },
  ];

  // Affiliation comes from a paper, which may be out of date: inferred, never verified.
  const organizations: Organization[] = [...a.orgs.values()].map((name) => ({
    name,
    lab: null,
    status: "inferred", // a publication affiliation does not prove a current position
    source: `https://openalex.org/${a.id}`,
    retrievedAt: now,
  }));

  const inState = stateVerifiable && a.inState && req.state;
  const newestYear = Number(newest?.date.slice(0, 4)) || 2000;

  return {
    id: `oa-${a.id}`,
    orcid: a.orcid ? a.orcid.replace(/^https?:\/\/orcid\.org\//, "") : null,
    openalexId: a.id,
    name: a.name,
    organizations,
    // OpenAlex does not identify career stage. Profile inspection must check it.
    stage: unknownClaim("OpenAlex does not report career stage."),
    location:
      inState && req.state
        ? {
            value: req.state,
            status: "inferred",
            source: `https://openalex.org/${a.id}`,
            retrievedAt: now,
            note: "Institution is in this state per OpenAlex. A publication affiliation does not prove a current position.",
          }
        : unknownClaim("No location found yet."),
    focus: unknownClaim("No profile inspected yet."),
    fit: `Author on ${a.works.size} matching work${a.works.size === 1 ? "" : "s"}. Most recent: "${newest?.label ?? "n/a"}".`,
    methods: [],
    evidence,
    opportunityChecks: [],
    unresolvedQuestions: [],
    matchedQueries: [...a.queries],
    profiles: [],
    foundBy: ["openalex"],
    score: a.works.size * 10 + a.queries.size * 5 + Math.max(0, newestYear - 2015),
  };
}
