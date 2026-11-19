import { errMessage } from "@/lib/pool";
import type { Lead, ProviderOutcome } from "@/lib/leads";
import type { WebQuery } from "@/lib/webQueries";

const ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const GAP_MS = 1100; // the free plan allows about one request per second

export const braveConfigured = () => Boolean(process.env.BRAVE_API_KEY);

type BraveResult = { url: string; title?: string; description?: string };

export async function braveCall(text: string): Promise<BraveResult[]> {
  const url = new URL(ENDPOINT);
  url.searchParams.set("q", text);
  url.searchParams.set("count", "20");
  url.searchParams.set("country", "us");
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": process.env.BRAVE_API_KEY ?? "",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 429 && attempt === 0) {
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }
    if (res.status === 401 || res.status === 403) throw new Error("BRAVE_API_KEY was rejected");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { web?: { results?: BraveResult[] } };
    return body.web?.results ?? [];
  }
  return [];
}

export async function braveDiscover(queries: WebQuery[]): Promise<ProviderOutcome> {
  if (!braveConfigured()) {
    return { leads: [], errors: [{ source: "brave", message: "BRAVE_API_KEY not set; skipped." }] };
  }
  const leads: Lead[] = [];
  const errors: ProviderOutcome["errors"] = [];
  for (let i = 0; i < queries.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, GAP_MS));
    try {
      for (const hit of await braveCall(queries[i].text)) {
        leads.push({
          url: hit.url,
          title: hit.title ?? null,
          snippet: hit.description ?? null,
          source: "brave",
          queryId: `brave:${queries[i].id}`,
        });
      }
    } catch (e) {
      errors.push({ source: `brave:${queries[i].id}`, message: errMessage(e) });
    }
  }
  return { leads, errors };
}
