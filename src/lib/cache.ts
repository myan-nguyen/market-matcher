/**
 * Small in-process cache for public source data. Equal keys share one in-flight
 * request, and a successful result is reused until it goes stale. Failures are
 * never cached. Separate from the user's session-only saved results.
 */
export class TtlCache<T> {
  private entries = new Map<string, { at: number; value: T }>();
  private inflight = new Map<string, Promise<T>>();

  constructor(
    private ttlMs: number,
    private maxEntries = 500,
  ) {}

  has(key: string): boolean {
    const hit = this.entries.get(key);
    return Boolean(hit && Date.now() - hit.at < this.ttlMs);
  }

  memo(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return Promise.resolve(hit.value);
    const running = this.inflight.get(key);
    if (running) return running;
    const p = load()
      .then((value) => {
        this.entries.set(key, { at: Date.now(), value });
        if (this.entries.size > this.maxEntries) {
          const oldest = this.entries.keys().next().value;
          if (oldest !== undefined) this.entries.delete(oldest);
        }
        return value;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }
}
