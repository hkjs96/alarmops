/**
 * Security B-1: per-source flood limit for authenticated callers (spec "폭주 제한").
 * Fixed one-minute window, per Lambda instance (best effort: N warm instances allow up to N× the limit).
 * The hard, global limit is API Gateway route throttling — see docs/infra-todo/ingest-throttling.md.
 */
export const DEFAULT_SOURCE_LIMIT_PER_MIN = 600;

export class SourceRateLimiter {
  private windows = new Map<string, { start: number; count: number }>();
  constructor(private readonly limitPerMin = DEFAULT_SOURCE_LIMIT_PER_MIN, private readonly maxKeys = 10_000) {}

  /** Returns 'OK', 'LIMITED_FIRST' (first rejection in this window, worth one audit row) or 'LIMITED'. */
  check(sourceId: string, now: Date): 'OK' | 'LIMITED_FIRST' | 'LIMITED' {
    const minute = Math.floor(now.getTime() / 60_000);
    let w = this.windows.get(sourceId);
    if (!w || w.start !== minute) {
      if (!w && this.windows.size >= this.maxKeys) this.windows.clear();
      w = { start: minute, count: 0 };
      this.windows.set(sourceId, w);
    }
    w.count++;
    if (w.count <= this.limitPerMin) return 'OK';
    return w.count === this.limitPerMin + 1 ? 'LIMITED_FIRST' : 'LIMITED';
  }
}
