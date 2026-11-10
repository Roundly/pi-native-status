import { cpus, freemem, hostname, totalmem } from "node:os";

const HISTORY_LENGTH = 32;
const CPU_FIELDS = ["user", "nice", "sys", "idle", "irq"] as const;
type CpuField = (typeof CPU_FIELDS)[number];
type CpuCounters = Record<CpuField, number>;

/** The injectable boundary is the same numeric data exposed by node:os. */
export interface ResourceReading {
  host: string;
  cpus: readonly { times: CpuCounters }[];
  memoryFreeBytes: number;
  memoryTotalBytes: number;
}

export interface ResourceSnapshot {
  host: string;
  cpuRatio: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  cpuHistory: (number | null)[];
  memoryHistory: (number | null)[];
}

function safe<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

function readOperatingSystem(): ResourceReading {
  // Read independently so an unavailable CPU counter does not hide memory.
  return {
    host: safe(hostname, "unknown"),
    cpus: safe(cpus, []),
    memoryFreeBytes: safe(freemem, Number.NaN),
    memoryTotalBytes: safe(totalmem, Number.NaN),
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function byteCount(value: unknown): value is number {
  return nonnegative(value) && Number.isSafeInteger(value);
}

function hostName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const host = value.trim();
  // Do not let an injected reader or an unusual hostname insert terminal control.
  return host && !/[\u0000-\u001f\u007f-\u009f]/.test(host) ? host : null;
}

function cpuCounters(value: unknown): CpuCounters[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const counters: CpuCounters[] = [];
  for (const cpu of value) {
    const times = record(record(cpu)?.times);
    if (!times || CPU_FIELDS.some((field) => !nonnegative(times[field]))) return null;
    // Copy the numbers: readers are allowed to reuse and mutate their objects.
    counters.push({
      user: times.user as number,
      nice: times.nice as number,
      sys: times.sys as number,
      idle: times.idle as number,
      irq: times.irq as number,
    });
  }
  return counters;
}

function cpuUtilization(previous: CpuCounters[] | null, current: CpuCounters[]): number | null {
  if (!previous || previous.length !== current.length) return null;
  let busy = 0;
  let idle = 0;
  for (let index = 0; index < current.length; index += 1) {
    for (const field of CPU_FIELDS) {
      const delta = current[index][field] - previous[index][field];
      // Per-counter checking catches resets even when the aggregate increased.
      if (!nonnegative(delta)) return null;
      if (field === "idle") idle += delta;
      else busy += delta;
    }
  }
  const total = busy + idle;
  if (!Number.isFinite(total) || total <= 0) return null;
  return Math.max(0, Math.min(1, busy / total));
}

/**
 * Host-wide resource sampling, independent of any terminal emulator.
 * CPU is the busy fraction between successful samples, summed across cores.
 * Memory is total - free; it includes caches and is not macOS memory pressure.
 * This class owns no timer, process, file, network request, or persistent state.
 */
export class ResourceSampler {
  private previousCpus: CpuCounters[] | null = null;
  private host = "unknown";
  private cpuHistory: (number | null)[] = [];
  private memoryHistory: (number | null)[] = [];
  private readonly read: () => ResourceReading;

  constructor(read: () => ResourceReading = readOperatingSystem) {
    this.read = read;
  }

  reset(): void {
    this.previousCpus = null;
    this.host = "unknown";
    this.cpuHistory = [];
    this.memoryHistory = [];
  }

  sample(): ResourceSnapshot {
    let raw: Record<string, unknown> | null = null;
    let current: CpuCounters[] | null = null;
    let memoryTotalBytes: number | null = null;
    let memoryUsedBytes: number | null = null;
    try {
      raw = record(this.read());
      this.host = hostName(raw?.host) ?? this.host;
      current = cpuCounters(raw?.cpus);
      const total = raw?.memoryTotalBytes;
      const free = raw?.memoryFreeBytes;
      if (byteCount(total) && total > 0) {
        memoryTotalBytes = total;
        if (byteCount(free) && free <= total) memoryUsedBytes = total - free;
      }
    } catch {
      // Read failure drops the baseline instead of reporting a stale CPU value.
      current = null;
    }
    const cpuRatio = current ? cpuUtilization(this.previousCpus, current) : null;
    this.previousCpus = current;
    const memoryRatio = memoryUsedBytes !== null && memoryTotalBytes !== null
      ? memoryUsedBytes / memoryTotalBytes
      : null;
    this.cpuHistory.push(cpuRatio);
    this.memoryHistory.push(memoryRatio);
    if (this.cpuHistory.length > HISTORY_LENGTH) this.cpuHistory.shift();
    if (this.memoryHistory.length > HISTORY_LENGTH) this.memoryHistory.shift();
    return {
      host: this.host,
      cpuRatio,
      memoryUsedBytes,
      memoryTotalBytes,
      // Returned snapshots cannot mutate the internal history.
      cpuHistory: [...this.cpuHistory],
      memoryHistory: [...this.memoryHistory],
    };
  }
}
