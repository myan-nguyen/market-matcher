import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { hostOf, isSafePublicUrl, normalizeUrl } from "@/lib/leads";
import { pool } from "@/lib/pool";

const USER_AGENT = "MarketMatcher/0.1 (research outreach tool; reads selected public profile pages)";
const FETCH_TIMEOUT_MS = 10000;
const MAX_CHARS = 1_500_000;
const FETCH_CONCURRENCY = 6;

export type StageHit = {
  kind: "postdoc" | "phd-candidate" | "phd-student" | "faculty";
  text: string;
  where: "jobTitle" | "h1" | "title" | "body";
};

/** One person's entry on a directory page: profile link, listed text, and other links such as a personal site. */
export type DirectoryLink = { name: string; url: string; context: string; others: string[] };

export type ParsedPage = {
  url: string;
  kind: "person" | "directory" | "other" | "error";
  name?: string | null;
  orgs?: string[];
  headline?: string;
  stage_hits?: StageHit[];
  states?: string[];
  focus?: string | null;
  links?: DirectoryLink[]; // individual profile links, set for directory pages
  emails?: string[]; // published on the page (mailto: or visible text), never guessed
  contact_page?: string | null;
  error?: string;
};

export type FetchLogEntry = { url: string; ok: boolean; error: string | null };

export type FetchedPage = { url: string; finalUrl: string; html: string; retrievedAt: string };
export type InspectedPage = { fetched: FetchedPage; parsed: ParsedPage };

/* ---------- robots.txt (minimal: honors Disallow for User-agent: *) ---------- */

const robotsCache = new Map<string, Promise<string[]>>();

async function loadDisallows(origin: string): Promise<string[]> {
  try {
    const res = await fetch(`${origin}/robots.txt`, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const rules: string[] = [];
    let applies = false;
    let lastWasAgent = false;
    for (const raw of (await res.text()).split(/\r?\n/)) {
      const line = raw.split("#")[0].trim();
      const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
      if (!m) continue;
      const key = m[1].toLowerCase();
      if (key === "user-agent") {
        applies = lastWasAgent ? applies || m[2] === "*" : m[2] === "*";
        lastWasAgent = true;
      } else {
        lastWasAgent = false;
        if (key === "disallow" && applies && m[2]) rules.push(m[2]);
      }
    }
    return rules;
  } catch {
    return []; // an unreachable robots.txt is treated as no restrictions
  }
}

async function robotsAllows(u: URL): Promise<boolean> {
  const cached = robotsCache.get(u.origin) ?? loadDisallows(u.origin);
  robotsCache.set(u.origin, cached);
  const rules = await cached;
  const target = u.pathname + u.search;
  return !rules.some((r) => target.startsWith(r.replace(/\*$/, "")));
}

/* ---------- fetching ---------- */

// Public pages are reused across searches. A fresh copy is served as-is; a stale one is
// revalidated with If-None-Match / If-Modified-Since, so an unchanged page costs no download.
const PAGE_FRESH_MS = 15 * 60_000;
const PAGE_MAX = 150;
type CachedPage = { at: number; etag: string | null; lastModified: string | null; page: FetchedPage };
const pageCache = new Map<string, CachedPage>();
const pageInflight = new Map<string, Promise<FetchedPage>>();

export function fetchPage(url: string): Promise<FetchedPage> {
  const key = normalizeUrl(url);
  const running = pageInflight.get(key);
  if (running) return running;
  const p = fetchPageUncached(url, key).finally(() => pageInflight.delete(key));
  pageInflight.set(key, p);
  return p;
}

async function fetchPageUncached(url: string, key: string): Promise<FetchedPage> {
  const cached = pageCache.get(key);
  if (cached && Date.now() - cached.at < PAGE_FRESH_MS) return { ...cached.page, url };
  const u = new URL(url);
  if (!(await robotsAllows(u))) throw new Error("blocked by robots.txt");
  const headers: Record<string, string> = { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" };
  if (cached?.etag) headers["If-None-Match"] = cached.etag;
  if (cached?.lastModified) headers["If-Modified-Since"] = cached.lastModified;
  const res = await fetch(u, {
    headers,
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    cache: "no-store",
  });
  if (res.status === 304 && cached) {
    const page = { ...cached.page, url, retrievedAt: new Date().toISOString() };
    pageCache.set(key, { ...cached, at: Date.now(), page });
    return page;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const finalUrl = res.url || url;
  if (!isSafePublicUrl(finalUrl)) throw new Error("redirected to a non-public address");
  const type = res.headers.get("content-type") ?? "";
  if (!/html|xml/i.test(type)) throw new Error(`not HTML (${type || "unknown type"})`);
  const html = (await res.text()).slice(0, MAX_CHARS);
  const page = { url, finalUrl, html, retrievedAt: new Date().toISOString() };
  pageCache.set(key, { at: Date.now(), etag: res.headers.get("etag"), lastModified: res.headers.get("last-modified"), page });
  if (pageCache.size > PAGE_MAX) {
    const oldest = pageCache.keys().next().value;
    if (oldest !== undefined) pageCache.delete(oldest);
  }
  return page;
}

/* ---------- Beautiful Soup bridge ---------- */

function pythonBin(): string {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  const venv = path.join(process.cwd(), ".venv", "bin", "python");
  return existsSync(venv) ? venv : "python3";
}

/**
 * On Vercel the Node runtime has no Python, so pages go to the Python function at
 * /api/parse (api/parse.py), which runs the same parser. Locally Python is spawned.
 */
// Vercel rejects request bodies over 4.5 MB (FUNCTION_PAYLOAD_TOO_LARGE), so pages are
// sent in batches under ~3 MB, and a single huge page is trimmed (profile facts sit near the top).
const REMOTE_BATCH_BYTES = 1_500_000;
const REMOTE_PAGE_CHARS = 400_000;

async function runRemoteParser(pages: FetchedPage[]): Promise<ParsedPage[]> {
  const host = process.env.PARSER_URL ?? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL}`;
  const base = host.replace(/\/$/, "");
  const items = pages.map((p) => ({ url: p.finalUrl, html: p.html.slice(0, REMOTE_PAGE_CHARS) }));

  const batches: (typeof items)[] = [];
  let cur: typeof items = [];
  let size = 0;
  for (const it of items) {
    const n = Buffer.byteLength(it.html) + it.url.length + 50;
    if (cur.length && size + n > REMOTE_BATCH_BYTES) {
      batches.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(it);
    size += n;
  }
  if (cur.length) batches.push(cur);

  const send = async (batch: typeof items): Promise<ParsedPage[]> => {
    const res = await fetch(`${base}/api/parse`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-parser-secret": process.env.PARSER_SECRET ?? "" },
      body: JSON.stringify(batch),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`remote parser HTTP ${res.status}`);
    return (await res.json()) as ParsedPage[];
  };
  // On a size/timeout failure, split the batch in half and retry; a single failing page becomes an error entry.
  const post = async (batch: typeof items): Promise<ParsedPage[]> => {
    try {
      return await send(batch);
    } catch (e) {
      if (batch.length > 1) {
        const mid = Math.ceil(batch.length / 2);
        const [a, b] = await Promise.all([post(batch.slice(0, mid)), post(batch.slice(mid))]);
        return [...a, ...b];
      }
      const msg = e instanceof Error ? e.message : String(e);
      return [{ url: batch[0].url, kind: "error", error: msg }];
    }
  };
  // A few batches at a time; order is kept so results line up with the input pages.
  const out: ParsedPage[][] = [];
  for (let i = 0; i < batches.length; i += 3) out.push(...(await Promise.all(batches.slice(i, i + 3).map(post))));
  return out.flat();
}

function runParser(pages: FetchedPage[]): Promise<ParsedPage[]> {
  if (process.env.VERCEL && !process.env.PYTHON_BIN) return runRemoteParser(pages);
  return new Promise((resolve, reject) => {
    const script = path.join(process.cwd(), "scripts", "parse_profile.py");
    const child = spawn(pythonBin(), [script], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("parser timed out"));
    }, 30000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`could not start Python parser: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`parser exited ${code}: ${err.slice(0, 200)}`));
      try {
        resolve(JSON.parse(out) as ParsedPage[]);
      } catch {
        reject(new Error("parser returned invalid JSON"));
      }
    });
    child.stdin.end(JSON.stringify(pages.map((p) => ({ url: p.finalUrl, html: p.html }))));
  });
}

/** Fetches public pages politely, then parses them with Beautiful Soup. */
export async function inspectUrls(
  urls: string[],
): Promise<{ pages: InspectedPage[]; failed: number; parserError: string | null; fetchLog: FetchLogEntry[] }> {
  // One read per distinct page, however many paths or directory entries pointed at it.
  const seen = new Set<string>();
  const unique = urls.filter((u) => {
    const k = normalizeUrl(u);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const safe = unique.filter(isSafePublicUrl);
  const settled = await pool(
    safe.map((u) => () => fetchPage(u)),
    FETCH_CONCURRENCY,
  );
  const fetchLog: FetchLogEntry[] = settled.map((r, i) =>
    r.status === "fulfilled"
      ? { url: safe[i], ok: true, error: null }
      : { url: safe[i], ok: false, error: r.reason instanceof Error ? r.reason.message : String(r.reason) },
  );
  for (const u of unique) {
    if (!safe.includes(u)) fetchLog.push({ url: u, ok: false, error: "not a safe public URL" });
  }
  const fetched = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  const failed = unique.length - fetched.length;
  if (fetched.length === 0) return { pages: [], failed, parserError: null, fetchLog };
  try {
    const parsed = await runParser(fetched);
    const pages = fetched.map((f, i) => ({ fetched: f, parsed: parsed[i] }));
    return { pages, failed, parserError: null, fetchLog };
  } catch (e) {
    return { pages: [], failed, parserError: e instanceof Error ? e.message : String(e), fetchLog };
  }
}

export const pageHost = (p: InspectedPage) => hostOf(p.fetched.finalUrl);
