/**
 * One queue per provider. Every call to that provider, searches and person
 * lookups alike, goes through `schedule`, so the rate and concurrency limits
 * are provider-wide. It never rotates keys or proxies.
 *
 * This queue lives in one process. When the app runs on several serverless
 * instances, pass `gate` backed by a shared limiter (for example Redis) so all
 * instances draw from the same budget.
 */

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public retryAfterMs: number | null = null,
  ) {
    super(message);
  }
}

/** Retry-After is either seconds or an HTTP date. */
export function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

export type QueueOptions = {
  ratePerSec?: number; // starts at 5, never above 8 (the account limit is 10)
  concurrency?: number; // 2-3 concurrent calls
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxWaitMs?: number; // a Retry-After longer than this fails fast so partial results return
  cacheTtlMs?: number;
  gate?: () => Promise<void>; // shared limiter hook for multi-instance deployments
};

export type QueueStats = {
  requests: number;
  rateLimited: number;
  retries: number;
  cacheHits: number;
  failures: number;
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

export class ProviderQueue {
  readonly stats: QueueStats = { requests: 0, rateLimited: 0, retries: 0, cacheHits: 0, failures: 0 };
  private active = 0;
  private waiters: Array<() => void> = [];
  private nextAt = 0;
  private pausedUntil = 0;
  private cache = new Map<string, { at: number; value: unknown }>();
  private inflight = new Map<string, Promise<unknown>>();
  private gapMs: number;
  private o: Required<Omit<QueueOptions, "gate" | "ratePerSec">> & Pick<QueueOptions, "gate">;

  constructor(opts: QueueOptions = {}) {
    this.gapMs = 1000 / Math.min(opts.ratePerSec ?? 5, 8);
    this.o = {
      concurrency: opts.concurrency ?? 3,
      maxRetries: opts.maxRetries ?? 3,
      baseDelayMs: opts.baseDelayMs ?? 500,
      maxDelayMs: opts.maxDelayMs ?? 8000,
      maxWaitMs: opts.maxWaitMs ?? 15000,
      cacheTtlMs: opts.cacheTtlMs ?? 10 * 60_000,
      gate: opts.gate,
    };
  }

  snapshot(): QueueStats {
    return { ...this.stats };
  }

  /** `key` identifies a repeatable request: equal keys share a cached or in-flight result. */
  schedule<T>(key: string | null, task: () => Promise<T>): Promise<T> {
    if (key) {
      const hit = this.cache.get(key);
      if (hit && Date.now() - hit.at < this.o.cacheTtlMs) {
        this.stats.cacheHits++;
        return Promise.resolve(hit.value as T);
      }
      const pending = this.inflight.get(key);
      if (pending) {
        this.stats.cacheHits++;
        return pending as Promise<T>;
      }
    }
    const p = this.run(task).then((value) => {
      if (key) this.cache.set(key, { at: Date.now(), value });
      return value;
    });
    if (key) {
      this.inflight.set(key, p);
      const done = () => this.inflight.delete(key);
      p.then(done, done);
    }
    return p;
  }

  private async enter() {
    if (this.active < this.o.concurrency) {
      this.active++;
      return;
    }
    await new Promise<void>((r) => this.waiters.push(r)); // slot is handed over, count unchanged
  }

  private leave() {
    const next = this.waiters.shift();
    if (next) next();
    else this.active--;
  }

  private async run<T>(task: () => Promise<T>): Promise<T> {
    await this.enter();
    try {
      for (let attempt = 0; ; attempt++) {
        const start = Math.max(this.nextAt, this.pausedUntil, Date.now());
        this.nextAt = start + this.gapMs;
        await sleep(start - Date.now());
        await this.o.gate?.();
        this.stats.requests++;
        try {
          return await task();
        } catch (e) {
          const status = e instanceof HttpError ? e.status : 0;
          if (status === 429) this.stats.rateLimited++;
          const retryable = status === 429 || status === 503;
          const retryAfter = e instanceof HttpError ? e.retryAfterMs ?? 0 : 0;
          if (!retryable || attempt >= this.o.maxRetries || retryAfter > this.o.maxWaitMs) {
            this.stats.failures++;
            throw e;
          }
          const backoff = Math.min(this.o.maxDelayMs, this.o.baseDelayMs * 2 ** attempt);
          const delay = Math.max(retryAfter, backoff) + Math.random() * backoff * 0.25;
          this.pausedUntil = Date.now() + delay; // pauses the whole provider, not just this call
          this.stats.retries++;
        }
      }
    } finally {
      this.leave();
    }
  }
}
