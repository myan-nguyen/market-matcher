import type { Facets } from "@/types/search";
import type { WebQuery } from "@/lib/webQueries";

/**
 * Query widening with an LLM. The model only proposes *searches* (phrasings, synonyms,
 * subfields, likely departments/labs, and names it believes work on the topic).
 * Nothing it says becomes a result: every person must still be found on a scraped
 * page and pass the normal checks, so a hallucinated name simply finds nothing.
 */
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";
const TIMEOUT_MS = 20_000;
const MAX_QUERIES = 6;
const MAX_PEOPLE = 12;

export const llmConfigured = () => Boolean(process.env.ANTHROPIC_API_KEY);

const STAGE_HINT: Record<string, string> = {
  faculty: "faculty / principal investigators",
  postdoc: "postdoctoral researchers",
  "advanced-phd": "PhD students and candidates (lab member pages, personal homepages)",
  "early-phd": "PhD students (lab member pages, personal homepages)",
};

export async function llmQueries(f: Facets, stateLabel: string | null): Promise<{ queries: WebQuery[]; people?: string[]; error?: string }> {
  if (!llmConfigured()) return { queries: [] };
  const who = f.stages.length ? f.stages.map((s) => STAGE_HINT[s]).join(", ") : "researchers, research scientists, postdocs and principal investigators";
  const where = f.institution?.name ?? stateLabel ?? "anywhere in the US";
  const prompt = `You help find academic researchers by writing web search queries.
Topic: ${f.topic}
Field/cohort: ${f.cohort || "(any)"}
People wanted: ${who}
Location: ${where}

Do what an expert in this field would do: first recall the specific people who are best known for this work in the location, then search for their pages.
Reply with JSON only:
{"people": [{"name": "Full Name", "institution": "...", "role": "professor|postdoc|PhD student"}],
 "queries": ["..."]}
- "people": up to ${MAX_PEOPLE} real people you are confident currently work on this topic at an institution in the location, most relevant first. Match the people wanted (e.g. list PhD students if PhD students are wanted). Omit anyone you are unsure about.
- "queries": up to ${MAX_QUERIES} web searches to find more such people's profile, lab-member or homepage pages: field synonyms, subfields, and lab/group/department member pages at institutions in the location.
Keep each query under 12 words. No site: operators.`;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: ctl.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY!,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 1200, messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) return { queries: [], error: `Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}` };
    const data = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = data.content?.find((c) => c.type === "text")?.text ?? "";
    const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    const parsed = JSON.parse(json || "{}") as { queries?: unknown; people?: unknown };
    const namedPeople = (Array.isArray(parsed.people) ? parsed.people : [])
      .filter((p): p is { name: string; institution?: string; role?: string } => !!p && typeof (p as { name?: unknown }).name === "string")
      .slice(0, MAX_PEOPLE);
    // Named people become one targeted search each ("Full Name Institution role"),
    // placed first: that is how a chat assistant answers, recall then verify.
    const named = namedPeople.map((p) => `${p.name} ${p.institution ?? ""} ${p.role ?? ""}`);
    const list = [...named, ...(Array.isArray(parsed.queries) ? parsed.queries : []).slice(0, MAX_QUERIES)];
    const seen = new Set<string>();
    const queries = list
      .filter((q): q is string => typeof q === "string")
      .map((q) => q.replace(/\s+/g, " ").trim())
      .filter((q) => q && !seen.has(q.toLowerCase()) && seen.add(q.toLowerCase()))
      .map((text, i) => ({ id: `llm${i + 1}`, text, branch: i < named.length ? "llm-person" : "llm" }));
    return { queries, people: namedPeople.map((p) => p.name) };
  } catch (e) {
    return { queries: [], error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}
