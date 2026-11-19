import { errMessage } from "@/lib/pool";
import type { Lead, ProviderOutcome } from "@/lib/leads";
import { HttpError, ProviderQueue, parseRetryAfter } from "@/lib/providers/queue";
import type { WebQuery } from "@/lib/webQueries";

const ENDPOINT = "https://api.exa.ai/search";
const NUM_RESULTS = 20;

export const exaConfigured = () => Boolean(process.env.EXA_API_KEY);

/** Shared by searches and person lookups: one budget for the whole provider. */
export const exaQueue = new ProviderQueue({ ratePerSec: 5, concurrency: 3 });

export type ExaResult = { url: string; title?: string | null; text?: string | null };

async function exaCall(text: string, people: boolean, num: number): Promise<ExaResult[]> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "x-api-key": process.env.EXA_API_KEY ?? "",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: text,
      type: "auto",
      numResults: num,
      contents: { text: { maxCharacters: 400 } }, // excerpt used when the page cannot be fetched
      // The people index is one path. The general path below leaves category unset.
      ...(people ? { category: "people" } : {}),
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 401 || res.status === 403) throw new HttpError(res.status, "EXA_API_KEY was rejected");
  if (!res.ok) {
    throw new HttpError(
      res.status,
      `HTTP ${res.status} ${(await res.text()).slice(0, 140)}`,
      parseRetryAfter(res.headers.get("retry-after")),
    );
  }
  const body = (await res.json()) as { results?: ExaResult[] };
  return body.results ?? [];
}

/** Repeated queries are cached and identical in-flight queries share one request. */
export function exaSearch(text: string, people: boolean, num: number = NUM_RESULTS): Promise<ExaResult[]> {
  const key = `${people ? "p" : "w"}|${num}|${text.trim().toLowerCase()}`;
  return exaQueue.schedule(key, () => exaCall(text, people, num));
}

/** people=true searches Exa's People index. people=false is a general web search. */
export async function exaDiscover(queries: WebQuery[], people: boolean): Promise<ProviderOutcome> {
  const source = people ? "exa-people" : "exa-web";
  if (!exaConfigured()) {
    return { leads: [], errors: [{ source, message: "EXA_API_KEY not set; skipped." }] };
  }
  const settled = await Promise.allSettled(queries.map((q) => exaSearch(q.text, people)));
  const leads: Lead[] = [];
  const errors: ProviderOutcome["errors"] = [];
  settled.forEach((r, i) => {
    if (r.status === "rejected") {
      errors.push({ source: `${source}:${queries[i].id}`, message: errMessage(r.reason) });
      return;
    }
    for (const hit of r.value) {
      leads.push({
        url: hit.url,
        title: hit.title ?? null,
        snippet: hit.text ?? null,
        source,
        queryId: `${source}:${queries[i].id}`,
      });
    }
  });
  return { leads, errors };
}
