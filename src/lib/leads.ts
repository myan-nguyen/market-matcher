import type { SourceError } from "@/types/search";

export type LeadSource = "exa-people" | "exa-web" | "brave" | "institutional" | "lookup" | "llm";

/**
 * The one output contract every provider returns. The engine never cares who
 * found a lead. The person name and organization come from the inspected page,
 * so `title` and `snippet` are only hints (excerpt) until then.
 */
export type Lead = {
  url: string; // evidence URL
  title: string | null; // possible candidate name or page title
  snippet: string | null; // excerpt
  source: LeadSource; // source type
  queryId: string;
  retrievedAt?: string; // ISO timestamp, filled by the engine when absent
  forCandidate?: string; // set for per-person lookups
};

export type ProviderOutcome = { leads: Lead[]; errors: SourceError[] };

export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) {
      if (k.startsWith("utm_")) u.searchParams.delete(k);
    }
    return u.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return raw;
  }
}

export const hostOf = (raw: string): string => {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return "";
  }
};

/** Hosts we treat as an institution's own site. Anything else needs a second look. */
export function isInstitutionalHost(host: string): boolean {
  return (
    /\.edu$/.test(host) ||
    /\.gov$/.test(host) ||
    /\.edu\.[a-z]{2}$/.test(host) ||
    /\.ac\.[a-z]{2}$/.test(host)
  );
}

/** Pages that are rarely a person's own profile. Dropped before inspection. */
const NOISE_HOSTS = [
  "linkedin.com", "facebook.com", "twitter.com", "x.com", "instagram.com",
  "youtube.com", "wikipedia.org", "researchgate.net", "scholar.google.com",
  "amazon.com", "reddit.com",
];

export function isNoiseHost(host: string): boolean {
  return NOISE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/** Blocks non-http(s) URLs and obvious local or private hosts before the server fetches them. */
export function isSafePublicUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return false;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return false;
  if (h.includes(":") || h === "[::1]") return false; // IPv6 literals
  return true;
}
