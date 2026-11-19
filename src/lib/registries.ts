import { TtlCache } from "@/lib/cache";
import { keyTerms } from "@/lib/keyphrases";
import { orgOverlap } from "@/lib/identity";
import { errMessage } from "@/lib/pool";
import { unknownClaim } from "@/lib/verify";
import type { Candidate, Claim, Evidence, Facets, SearchRequest, SourceError, StageCode } from "@/types/search";

/**
 * Authoritative registries: grants (NIH RePORTER, NSF Awards), researcher IDs (ORCID)
 * and papers (Semantic Scholar). Each is ONE capped request per search, cached, and
 * free to call. They only *nominate* people; every person still needs a scraped page
 * (author lookup) or other evidence to rank well, exactly like OpenAlex authors.
 *
 * Grant types say a lot about career stage, which is the main reason to add them:
 *   NIH F31 / NSF GRFP  -> PhD student      NIH F32 / K99 -> postdoc
 *   NIH R/U/P/K (non-K99) and NSF PI awards -> faculty / PI
 */

const ROWS = 50; // per source, per search
const TIMEOUT_MS = 12_000;
const YEARS_BACK = 4;
const cache = new TtlCache<RegistryOutcome>(30 * 60_000, 200);

export type RegistryOutcome = { candidates: Candidate[]; errors: SourceError[]; source: string };

/** Who may create new people: grant registries can; paper-only sources only corroborate. */
export type RegistryCandidate = Candidate & { nominate: boolean };

const now = () => new Date().toISOString();
const year = () => new Date().getFullYear();
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");
const titleCase = (s: string) => s.toLowerCase().replace(/\b\p{L}/gu, (c) => c.toUpperCase());

function stageClaim(value: StageCode | null, source: string, note: string): Claim<StageCode> {
  return value ? { value, status: "inferred", source, retrievedAt: now(), note } : unknownClaim("Registry does not state career stage.");
}

function base(
  id: string,
  name: string,
  org: string | null,
  state: string | null,
  stage: Claim<StageCode>,
  evidence: Evidence[],
  foundBy: string,
  score: number,
  nominate: boolean,
): RegistryCandidate {
  const src = evidence[0]?.url ?? null;
  return {
    id,
    orcid: null,
    openalexId: null,
    name,
    organizations: org ? [{ name: org, lab: null, status: "inferred", source: src, retrievedAt: now() }] : [],
    stage,
    location: state
      ? { value: state, status: "inferred", source: src, retrievedAt: now(), note: `Award/record lists the institution in ${state}.` }
      : unknownClaim("No location found yet."),
    focus: unknownClaim("No profile inspected yet."),
    fit: evidence[0] ? `${foundBy}: "${evidence[0].label}"` : "",
    methods: [],
    evidence,
    opportunityChecks: [],
    unresolvedQuestions: [],
    matchedQueries: [foundBy],
    profiles: [],
    foundBy: [foundBy],
    score,
    nominate,
  };
}

async function getJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const topicText = (f: Facets) => (keyTerms(f.topic).length ? keyTerms(f.topic) : f.topic.split(/\s+/)).join(" ");

/* ---------- NIH RePORTER (no key) ---------- */

function nihStage(code: string): StageCode | null {
  if (/^(F30|F31|T32|TL1)$/.test(code)) return "advanced-phd";
  if (/^(F32|K99|T90)$/.test(code)) return "postdoc";
  if (/^(R|U|P|K|DP|S|RF|UG|UH|UM|SC)\w*$/.test(code)) return "faculty";
  return null;
}

async function nih(f: Facets, req: SearchRequest): Promise<RegistryOutcome> {
  const y = year();
  const body = {
    criteria: {
      advanced_text_search: { operator: "and", search_field: "projecttitle,terms,abstracttext", search_text: topicText(f) },
      fiscal_years: Array.from({ length: YEARS_BACK }, (_, i) => y - i),
      ...(req.state ? { org_states: [req.state] } : {}),
      ...(f.institution ? { org_names: [f.institution.name] } : {}),
    },
    include_fields: ["ApplId", "ProjectTitle", "FiscalYear", "ActivityCode", "PrincipalInvestigators", "Organization", "ProjectStartDate"],
    limit: ROWS,
    sort_field: "fiscal_year",
    sort_order: "desc",
  };
  type Row = {
    appl_id: number;
    project_title: string;
    fiscal_year: number;
    activity_code: string;
    project_start_date?: string;
    principal_investigators?: { full_name: string; first_name?: string; last_name?: string; profile_id?: number }[];
    organization?: { org_name?: string; org_state?: string };
  };
  const data = (await getJson("https://api.reporter.nih.gov/v2/projects/search", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  })) as { results?: Row[] };
  const byPi = new Map<string, RegistryCandidate>();
  for (const r of data.results ?? []) {
    for (const pi of r.principal_investigators ?? []) {
      const name = titleCase([pi.first_name, pi.last_name].filter(Boolean).join(" ") || pi.full_name);
      if (name.split(" ").length < 2) continue;
      const url = `https://reporter.nih.gov/project-details/${r.appl_id}`;
      const ev: Evidence = { type: "project", label: `NIH ${r.activity_code}: ${r.project_title}`, url, date: (r.project_start_date ?? `${r.fiscal_year}-01-01`).slice(0, 10) };
      const key = String(pi.profile_id ?? slug(name));
      const hit = byPi.get(key);
      if (hit) {
        if (hit.evidence.length < 4) hit.evidence.push(ev);
        hit.score += 5;
        continue;
      }
      const st = nihStage(r.activity_code);
      byPi.set(
        key,
        base(`nih-${key}`, name, r.organization?.org_name ? titleCase(r.organization.org_name) : null, r.organization?.org_state ?? null,
          stageClaim(st, url, `NIH ${r.activity_code} award (${st === "advanced-phd" ? "predoctoral fellowship/training" : st === "postdoc" ? "postdoctoral award" : "PI award"}).`),
          [ev], "nih", 40 + Math.max(0, r.fiscal_year - (year() - YEARS_BACK)), true),
      );
    }
  }
  return { candidates: [...byPi.values()], errors: [], source: "nih" };
}

/* ---------- NSF Awards (no key) ---------- */

async function nsf(f: Facets, req: SearchRequest): Promise<RegistryOutcome> {
  const u = new URL("https://api.nsf.gov/services/v1/awards.json");
  u.searchParams.set("keyword", topicText(f));
  if (req.state) u.searchParams.set("awardeeStateCode", req.state);
  if (f.institution) u.searchParams.set("awardeeName", f.institution.name);
  u.searchParams.set("dateStart", `01/01/${year() - YEARS_BACK}`);
  u.searchParams.set("printFields", "id,title,piFirstName,piLastName,awardeeName,awardeeStateCode,startDate,fundProgramName");
  u.searchParams.set("rpp", String(ROWS));
  type Row = { id: string; title: string; piFirstName?: string; piLastName?: string; awardeeName?: string; awardeeStateCode?: string; startDate?: string; fundProgramName?: string };
  const data = (await getJson(u.toString())) as { response?: { award?: Row[] } };
  const byPi = new Map<string, RegistryCandidate>();
  for (const r of data.response?.award ?? []) {
    const name = titleCase([r.piFirstName, r.piLastName].filter(Boolean).join(" "));
    if (name.split(" ").length < 2) continue;
    const url = `https://www.nsf.gov/awardsearch/showAward?AWD_ID=${r.id}`;
    const [m, d, y] = (r.startDate ?? "").split("/");
    const ev: Evidence = { type: "project", label: `NSF: ${r.title}`, url, date: y ? `${y}-${m}-${d}` : "" };
    const hit = byPi.get(slug(name));
    if (hit) {
      if (hit.evidence.length < 4) hit.evidence.push(ev);
      hit.score += 5;
      continue;
    }
    // Fellowship programs fund the student or postdoc as the named PI.
    const prog = r.fundProgramName ?? "";
    const st: StageCode = /graduate research fellowship|GRFP|doctoral dissertation/i.test(prog)
      ? "advanced-phd"
      : /postdoctoral/i.test(prog)
        ? "postdoc"
        : "faculty";
    byPi.set(slug(name), base(`nsf-${slug(name)}`, name, r.awardeeName ?? null, r.awardeeStateCode ?? null,
      stageClaim(st, url, `NSF award${prog ? ` (${prog})` : ""}.`), [ev], "nsf", 38, true));
  }
  return { candidates: [...byPi.values()], errors: [], source: "nsf" };
}

/* ---------- ORCID (public API; token optional) ---------- */

async function orcid(f: Facets, req: SearchRequest, inStateOrgs: string[]): Promise<RegistryOutcome> {
  const words = topicText(f).split(" ").filter(Boolean);
  const kw = words.map((w) => `keyword:${w}`).join(" AND ");
  const aff = f.institution ? ` AND affiliation-org-name:"${f.institution.name}"` : "";
  const u = new URL("https://pub.orcid.org/v3.0/expanded-search/");
  u.searchParams.set("q", `(${kw})${aff}`);
  u.searchParams.set("rows", String(ROWS));
  const headers: Record<string, string> = { accept: "application/json" };
  if (process.env.ORCID_ACCESS_TOKEN) headers.authorization = `Bearer ${process.env.ORCID_ACCESS_TOKEN}`;
  type Row = { "orcid-id": string; "given-names"?: string; "family-names"?: string; "institution-name"?: string[] };
  const data = (await getJson(u.toString(), { headers })) as { "expanded-result"?: Row[] | null };
  const out: RegistryCandidate[] = [];
  for (const r of data["expanded-result"] ?? []) {
    const name = [r["given-names"], r["family-names"]].filter(Boolean).join(" ").trim();
    if (name.split(" ").length < 2) continue;
    const insts = r["institution-name"] ?? [];
    // With a state selected, keep only people whose ORCID lists an in-state organization.
    const local = req.state ? insts.find((i) => orgOverlap([i], inStateOrgs)) : insts[0];
    if (req.state && !local) continue;
    const url = `https://orcid.org/${r["orcid-id"]}`;
    const c = base(`orcid-${r["orcid-id"]}`, name, local ?? null, req.state && local ? req.state : null,
      unknownClaim("ORCID search does not state career stage."),
      [{ type: "profile", label: "ORCID record (keywords match topic)", url, date: "" }], "orcid", 25, true);
    c.orcid = r["orcid-id"];
    out.push(c);
  }
  return { candidates: out, errors: [], source: "orcid" };
}

/* ---------- Semantic Scholar (key optional) ---------- */

async function semanticScholar(f: Facets): Promise<RegistryOutcome> {
  const u = new URL("https://api.semanticscholar.org/graph/v1/paper/search");
  u.searchParams.set("query", topicText(f));
  u.searchParams.set("fields", "title,year,url,authors");
  u.searchParams.set("year", `${year() - YEARS_BACK}-`);
  u.searchParams.set("limit", String(ROWS));
  const headers: Record<string, string> = {};
  if (process.env.SEMANTIC_SCHOLAR_API_KEY) headers["x-api-key"] = process.env.SEMANTIC_SCHOLAR_API_KEY;
  type Row = { title: string; year?: number; url?: string; authors?: { authorId?: string; name: string }[] };
  const data = (await getJson(u.toString(), { headers })) as { data?: Row[] };
  const byAuthor = new Map<string, RegistryCandidate>();
  for (const p of data.data ?? []) {
    for (const a of p.authors ?? []) {
      if (!a.authorId || a.name.split(" ").length < 2) continue;
      const ev: Evidence = { type: "publication", label: p.title, url: p.url ?? `https://www.semanticscholar.org/author/${a.authorId}`, date: p.year ? `${p.year}-01-01` : "" };
      const hit = byAuthor.get(a.authorId);
      if (hit) {
        if (hit.evidence.length < 4) hit.evidence.push(ev);
        continue;
      }
      // No affiliation in paper search results, so these only corroborate people
      // found elsewhere; they never create new candidates on their own.
      byAuthor.set(a.authorId, base(`s2-${a.authorId}`, a.name, null, null, unknownClaim("Semantic Scholar does not state career stage."), [ev], "semanticscholar", 10, false));
    }
  }
  return { candidates: [...byAuthor.values()], errors: [], source: "semanticscholar" };
}

/* ---------- all registries ---------- */

export async function searchRegistries(f: Facets, req: SearchRequest, inStateOrgs: string[]): Promise<RegistryOutcome[]> {
  const key = JSON.stringify([f.topic, f.institution?.name ?? "", req.state ?? "", inStateOrgs.length]);
  const run = (name: string, fn: () => Promise<RegistryOutcome>) =>
    cache.memo(`${name}|${key}`, fn).catch((e): RegistryOutcome => ({ candidates: [], errors: [{ source: name, message: errMessage(e) }], source: name }));
  return Promise.all([
    run("nih", () => nih(f, req)),
    run("nsf", () => nsf(f, req)),
    run("orcid", () => orcid(f, req, inStateOrgs)),
    run("semanticscholar", () => semanticScholar(f)),
  ]);
}
