/**
 * Per-request, client-observed metrics. All clocks are injected monotonic
 * milliseconds; this module never reads prompts, deltas, credentials or a clock.
 */
export type RequestSource = "provider-request" | "turn-start";
export type DeltaKind = "text" | "thinking" | "toolcall";
export type RequestOutcome = "complete" | "error" | "aborted";
export type RequestPhase = "idle" | "waiting" | "streaming" | RequestOutcome;

export interface ReportedUsage {
  input?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  output?: unknown;
}

export interface MetricsSnapshot {
  readonly phase: RequestPhase;
  readonly source: RequestSource | null;
  readonly measurement: "client-observed";
  readonly startedAtMs: number | null;
  readonly firstDeltaAtMs: number | null;
  readonly endedAtMs: number | null;
  readonly firstDeltaKind: DeltaKind | null;
  readonly elapsedMs: number | null;
  readonly ttftMs: number | null;
  readonly generationMs: number | null;
  readonly tokensPerSecond: number | null;
  readonly inputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly outputTokens: number | null;
  readonly contextUsedTokens: number | null;
  readonly cacheHitRate: number | null;
}

interface UsageValue {
  value: number | null;
  invalid: boolean;
}

function finiteNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function usageValue(value: unknown): UsageValue {
  // Omitted provider fields are absent, while explicit invalid values must not
  // silently become zero and understate context occupancy.
  if (value === undefined) return { value: null, invalid: false };
  return finiteNonnegative(value)
    ? { value, invalid: false }
    : { value: null, invalid: true };
}

function usageCounts(usage: ReportedUsage | null | undefined) {
  const input = usageValue(usage?.input);
  const read = usageValue(usage?.cacheRead);
  const write = usageValue(usage?.cacheWrite);
  const output = usageValue(usage?.output);
  const parts = [input, read, write];
  const sum = parts.reduce((total, part) => total + (part.value ?? 0), 0);
  const contextUsedTokens = parts.some(part => part.value !== null)
    && parts.every(part => !part.invalid)
    && Number.isFinite(sum)
    ? sum : null;
  return {
    inputTokens: input.value,
    cacheReadTokens: read.value,
    cacheWriteTokens: write.value,
    outputTokens: output.value,
    contextUsedTokens,
    cacheHitRate: contextUsedTokens !== null && contextUsedTokens > 0 && read.value !== null
      ? read.value / contextUsedTokens : null,
  };
}

export class RequestMetrics {
  private phase: RequestPhase = "idle";
  private source: RequestSource | null = null;
  private startedAtMs: number | null = null;
  private firstDeltaAtMs: number | null = null;
  private endedAtMs: number | null = null;
  private firstDeltaKind: DeltaKind | null = null;
  private lastObservedAtMs: number | null = null;
  private sawDelta = false;
  private counts = usageCounts(undefined);

  /** Starting another model request always removes the previous request's data. */
  begin(nowMs: number, source: RequestSource = "turn-start"): void {
    this.reset();
    this.phase = "waiting";
    this.source = source;
    this.startedAtMs = finiteNonnegative(nowMs) ? nowMs : null;
    this.lastObservedAtMs = this.startedAtMs;
  }

  /** Content is inspected for presence only and is never retained. */
  firstDelta(nowMs: number, kind: DeltaKind, delta: string): void {
    if (!this.active() || typeof delta !== "string" || delta.length === 0) return;
    if (kind !== "text" && kind !== "thinking" && kind !== "toolcall") return;

    const validTime = this.forwardTime(nowMs);
    if (!this.sawDelta) {
      this.sawDelta = true;
      this.phase = "streaming";
      this.firstDeltaKind = kind;
      // A bad first timestamp remains unknown. A later delta is not the first
      // token and must not replace its missing measurement.
      this.firstDeltaAtMs = validTime;
    }
    if (validTime !== null) this.lastObservedAtMs = validTime;
  }

  finish(
    nowMs: number,
    usage: ReportedUsage | null | undefined,
    outcome: RequestOutcome = "complete",
  ): void {
    if (!this.active()) return;
    this.endedAtMs = this.forwardTime(nowMs);
    if (this.endedAtMs !== null) this.lastObservedAtMs = this.endedAtMs;
    this.counts = usageCounts(usage);
    this.phase = outcome;
  }

  reset(): void {
    this.phase = "idle";
    this.source = null;
    this.startedAtMs = null;
    this.firstDeltaAtMs = null;
    this.endedAtMs = null;
    this.firstDeltaKind = null;
    this.lastObservedAtMs = null;
    this.sawDelta = false;
    this.counts = usageCounts(undefined);
  }

  snapshot(nowMs?: number): MetricsSnapshot {
    const active = this.active();
    const now = active
      ? nowMs === undefined ? this.lastObservedAtMs : this.forwardTime(nowMs)
      : this.endedAtMs;
    const elapsedMs = now !== null && this.startedAtMs !== null
      ? now - this.startedAtMs : null;
    const showTiming = active || this.phase === "complete";
    const ttftMs = showTiming && this.firstDeltaAtMs !== null && this.startedAtMs !== null
      ? this.firstDeltaAtMs - this.startedAtMs : null;
    const generationMs = this.phase === "complete" && this.endedAtMs !== null && this.firstDeltaAtMs !== null
      ? this.endedAtMs - this.firstDeltaAtMs : null;
    const rate = generationMs !== null && generationMs > 0 && this.counts.outputTokens !== null
      ? this.counts.outputTokens / (generationMs / 1000) : null;
    return {
      phase: this.phase,
      source: this.source,
      measurement: "client-observed",
      startedAtMs: this.startedAtMs,
      firstDeltaAtMs: this.firstDeltaAtMs,
      endedAtMs: this.endedAtMs,
      firstDeltaKind: this.firstDeltaKind,
      elapsedMs,
      ttftMs,
      generationMs,
      tokensPerSecond: rate !== null && Number.isFinite(rate) ? rate : null,
      ...this.counts,
    };
  }

  private active(): boolean {
    return this.phase === "waiting" || this.phase === "streaming";
  }

  private forwardTime(nowMs: number): number | null {
    if (!finiteNonnegative(nowMs) || this.startedAtMs === null) return null;
    if (nowMs < this.startedAtMs || (this.lastObservedAtMs !== null && nowMs < this.lastObservedAtMs)) return null;
    return nowMs;
  }
}
