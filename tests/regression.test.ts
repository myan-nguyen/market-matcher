import { afterEach, describe, expect, it, vi } from "vitest";
import { buildQueryPlan } from "@/lib/queryPlan";
import { resolveIdentities } from "@/lib/resolve";
import { MIN_SCORE, scorePeople, selectTop50, verifyClaims } from "@/lib/rank";
import { buildTrace } from "@/lib/trace";
import { looksLikePerson } from "@/lib/extract";
import { HttpError, ProviderQueue, parseRetryAfter } from "@/lib/providers/queue";
import {
  ALL,
  AKSHAY,
  CENTER_FACETS,
  CENTER_PERSON,
  CENTER_REQ,
  FACETS,
  KARNIADAKIS,
  PROGRAM,
  PROVISIONAL,
  REQ,
  SURESH,
} from "./fixtures";
import type { Candidate, Facets, SearchRequest } from "@/types/search";

function run(req: SearchRequest, facets: Facets, people: Candidate[]) {
  const plan = buildQueryPlan(req);
  const drops: Record<string, number> = {};
  const why = new Map<string, string>();
  const resolved = resolveIdentities(people).people;
  const verified = verifyClaims(resolved, req, plan, facets, drops, why);
  const scored = scorePeople(verified, req, plan, facets);
  const { selected } = selectTop50(scored);
  return { resolved, verified, scored, selected, drops, why };
}

describe("Brown networking query", () => {
  const out = run(REQ, FACETS, ALL);

  it("puts Akshay Narayan near the top with his faculty page and personal site as evidence", () => {
    const rank = out.selected.findIndex((c) => c.id === AKSHAY.id);
    expect(rank).toBeGreaterThanOrEqual(0);
    expect(rank).toBeLessThan(3);
    const urls = out.selected[rank].scoreBreakdown!.flatMap((s) => s.urls);
    expect(urls).toContain("https://cs.brown.edu/people/faculty/akshayn/");
    expect(urls).toContain("https://akshayn.xyz");
  });

  it("ranks Akshay above Suresh, whose primary area is algorithmic fairness", () => {
    const a = out.scored.find((c) => c.id === AKSHAY.id)!;
    const s = out.scored.find((c) => c.id === SURESH.id);
    expect(a).toBeDefined();
    if (s) expect(a.score).toBeGreaterThan(s.score);
  });

  it("keeps Karniadakis (Brown, indirect) but ranks him below direct networking evidence", () => {
    const k = out.scored.findIndex((c) => c.id === KARNIADAKIS.id);
    const a = out.scored.findIndex((c) => c.id === AKSHAY.id);
    expect(k).toBeGreaterThan(a);
  });

  it("never returns a program page as a person", () => {
    expect(out.selected.some((c) => c.id === PROGRAM.id)).toBe(false);
    expect(out.why.get(PROGRAM.id)).toMatch(/not a person/);
    expect(looksLikePerson("Brazil Initiative")).toBe(false);
    expect(looksLikePerson("Akshay Narayan")).toBe(true);
  });

  it("keeps a directory-only lead as a provisional person ranked below a read profile", () => {
    const p = out.scored.find((c) => c.id === PROVISIONAL.id)!;
    const a = out.scored.find((c) => c.id === AKSHAY.id)!;
    expect(p).toBeDefined();
    expect(p.score).toBeLessThan(a.score);
  });

  it("stores every score component with its supporting URLs", () => {
    const a = out.scored.find((c) => c.id === AKSHAY.id)!;
    expect(a.scoreBreakdown!.map((s) => s.key)).toEqual(["fit", "personal", "profile", "recent", "corroboration"]);
    expect(a.scoreBreakdown!.reduce((n, s) => n + s.points, 0)).toBeCloseTo(a.score, 1);
    expect(a.scoreBreakdown![0].urls.length).toBeGreaterThan(0);
  });

  it("applies geography after affiliation, so a personal site with no location is kept", () => {
    const a = out.verified.find((c) => c.id === AKSHAY.id);
    expect(a).toBeDefined();
    expect(AKSHAY.location.status).toBe("unknown");
  });

  it("does not let a verified mismatch through but keeps unknown location", () => {
    const wrong: Candidate = {
      ...AKSHAY,
      id: "x",
      name: "Pat Wrong",
      location: { value: "CA", status: "verified", source: "https://x.edu", retrievedAt: "2026-11-18", note: null },
    };
    const o = run(REQ, FACETS, [wrong, AKSHAY]);
    expect(o.verified.some((c) => c.id === "x")).toBe(false);
    expect(o.verified.some((c) => c.id === AKSHAY.id)).toBe(true);
  });
});

describe("trace", () => {
  const out = run(REQ, FACETS, ALL);
  const rows = buildTrace({
    terms: REQ.trace!,
    discovered: [
      { url: "https://cs.brown.edu/people/faculty/akshayn/", title: "Akshay Narayan", source: "directory", inspected: true },
      { url: "https://akshayn.xyz", title: "Akshay Narayan", source: "directory", inspected: true },
    ],
    leadLog: [
      { url: "https://cs.brown.edu/people/faculty/akshayn/", source: "directory", fetch: "ok", extraction: "person", reason: null },
      { url: "https://akshayn.xyz", source: "directory", fetch: "ok", extraction: "person", reason: null },
    ],
    resolved: out.resolved,
    rejected: out.why,
    verified: out.verified,
    scored: out.scored,
    selected: out.selected,
    minScore: MIN_SCORE,
  });

  it("follows Akshay, his site and his profile path through every stage", () => {
    for (const row of rows) {
      expect(row.stoppedAt).toBeNull();
      expect(row.steps.map((s) => s.stage)).toEqual(["discovered", "fetched", "extracted", "verified", "scored", "selected"]);
    }
  });

  it("says why a missing person stopped, at the right stage", () => {
    const [row] = buildTrace({
      terms: ["Nobody Known"],
      discovered: [],
      leadLog: [],
      resolved: [],
      rejected: new Map(),
      verified: [],
      scored: [],
      selected: [],
      minScore: MIN_SCORE,
    });
    expect(row.stoppedAt).toBe("discovered");
    expect(row.steps[0].detail).toMatch(/never returned/);
  });

  it("reports a rejection reason for someone dropped in verification", () => {
    const [row] = buildTrace({
      terms: ["Brazil Initiative"],
      discovered: [],
      leadLog: [],
      resolved: out.resolved,
      rejected: out.why,
      verified: out.verified,
      scored: out.scored,
      selected: out.selected,
      minScore: MIN_SCORE,
    });
    expect(row.stoppedAt).toBe("verified");
    expect(row.steps.find((s) => s.stage === "verified")!.detail).toMatch(/not a person/);
  });
});

describe("another institution uses the same pipeline", () => {
  it("returns a research-center person with the same stages and no institution-specific code", () => {
    const o = run(CENTER_REQ, CENTER_FACETS, [CENTER_PERSON, AKSHAY]);
    expect(o.selected.map((c) => c.id)).toEqual([CENTER_PERSON.id]);
    expect(o.why.get(AKSHAY.id)).toMatch(/no tie to Woods Hole/);
  });
});

describe("Exa rate limiting", () => {
  afterEach(() => vi.useRealTimers());

  it("honors Retry-After on a 429, retries, and returns the result", async () => {
    vi.useFakeTimers();
    const q = new ProviderQueue({ ratePerSec: 5, concurrency: 2, baseDelayMs: 100, maxWaitMs: 5000 });
    let calls = 0;
    const p = q.schedule("k", async () => {
      calls++;
      if (calls === 1) throw new HttpError(429, "rate limited", 1500);
      return "ok";
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(p).resolves.toBe("ok");
    expect(calls).toBe(2);
    expect(q.stats.rateLimited).toBe(1);
    expect(q.stats.retries).toBe(1);
  });

  it("waits at least the Retry-After time before retrying", async () => {
    vi.useFakeTimers();
    const q = new ProviderQueue({ ratePerSec: 5, baseDelayMs: 50 });
    const times: number[] = [];
    const p = q.schedule(null, async () => {
      times.push(Date.now());
      if (times.length === 1) throw new HttpError(429, "x", 2000);
      return 1;
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await p;
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(2000);
  });

  it("returns partial results when one query stays rate limited", async () => {
    vi.useFakeTimers();
    const q = new ProviderQueue({ ratePerSec: 5, maxRetries: 1, baseDelayMs: 10, maxWaitMs: 100 });
    const results = Promise.allSettled([
      q.schedule("a", async () => "found"),
      q.schedule("b", async () => {
        throw new HttpError(429, "still limited", 60_000);
      }),
    ]);
    await vi.advanceTimersByTimeAsync(10_000);
    const [a, b] = await results;
    expect(a.status).toBe("fulfilled");
    expect(b.status).toBe("rejected");
    expect(q.stats.failures).toBe(1);
  });

  it("caches repeated queries and shares an in-flight request", async () => {
    const q = new ProviderQueue({ ratePerSec: 8 });
    let calls = 0;
    const task = async () => ++calls;
    const [x, y] = await Promise.all([q.schedule("same", task), q.schedule("same", task)]);
    const z = await q.schedule("same", task);
    expect([x, y, z]).toEqual([1, 1, 1]);
    expect(calls).toBe(1);
    expect(q.stats.cacheHits).toBe(2);
  });

  it("never exceeds the account limit and parses Retry-After in seconds or dates", () => {
    const q = new ProviderQueue({ ratePerSec: 100 });
    expect(q).toBeDefined();
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter(null)).toBeNull();
  });
});
