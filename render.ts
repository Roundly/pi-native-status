/**
 * v0.4.2 compact visual layer for the native Pi status bar.
 *
 * One header line (CPU/RAM left, host right) and two footer lines: cwd/branch
 * plus the single model identity, then compact throughput/TTFT/cache with the
 * context percentage on the right. Secondary numbers live behind
 * `/native-status details`. Dynamic text is sanitised; no custom page band or
 * terminal profile is used.
 */
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  colorToRgb,
  parseColor,
  replaceControlCharacters,
  sliceByColumn,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { MetricsSnapshot } from "./metrics.ts";
import type { ResourceSnapshot } from "./resources.ts";

/** One restrained grey-teal accent, now reserved for a measured throughput number. */
export const PALETTE = {
  cool: "#8bd1c2",
  coolLight: "#2f6f68",
} as const;

export type StyleToken =
  | "accent"
  | "muted"
  | "dim"
  | "success"
  | "warning"
  | "error"
  | "text";

export interface PaintOptions {
  fg?: string;
  bg?: string;
  dim?: boolean;
  bold?: boolean;
}

export interface Style {
  fg(token: StyleToken, text: string): string;
  bold(text: string): string;
  paint(text: string, options: PaintOptions): string;
  emphasis(text: string): string;
}

const XTERM_LEVELS = [0, 95, 135, 175, 215, 255] as const;
const XTERM_PALETTE = (() => {
  const palette: { index: number; r: number; g: number; b: number }[] = [];
  for (let r = 0; r < 6; r += 1) {
    for (let g = 0; g < 6; g += 1) {
      for (let b = 0; b < 6; b += 1) {
        palette.push({ index: 16 + 36 * r + 6 * g + b, r: XTERM_LEVELS[r], g: XTERM_LEVELS[g], b: XTERM_LEVELS[b] });
      }
    }
  }
  for (let step = 0; step < 24; step += 1) {
    const value = 8 + step * 10;
    palette.push({ index: 232 + step, r: value, g: value, b: value });
  }
  return palette;
})();

function redmeanDistance(
  r: number,
  g: number,
  b: number,
  candidateR: number,
  candidateG: number,
  candidateB: number,
): number {
  const rmean = (r + candidateR) / 2;
  const dr = r - candidateR;
  const dg = g - candidateG;
  const db = b - candidateB;
  return (((512 + rmean) * dr * dr) >> 8) + 4 * dg * dg + (((767 - rmean) * db * db) >> 8);
}

/** Nearest standard xterm index in 16..255, including the grey ramp. */
export function nearestPaletteIndex(hex: string): number {
  const { r, g, b } = colorToRgb(parseColor(hex));
  let best = 16;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const entry of XTERM_PALETTE) {
    const distance = redmeanDistance(r, g, b, entry.r, entry.g, entry.b);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = entry.index;
    }
  }
  return best;
}

/** Adapt the active Pi theme without forcing terminal colours or a page band. */
export function styleFromTheme(theme: Theme): Style {
  // Pi swaps the theme instance behind a stable proxy, so the adapter must read
  // appearance and colour mode per paint instead of capturing them at creation.
  const colors = new Map<string, ReturnType<typeof parseColor>>();
  const color = (hex: string) => {
    const mode = theme.getColorMode();
    const key = `${mode}:${hex}`;
    const cached = colors.get(key);
    if (cached) return cached;
    const parsed = mode === "256color" ? parseColor(nearestPaletteIndex(hex)) : parseColor(hex);
    colors.set(key, parsed);
    return parsed;
  };
  const paintText = (text: string, options: PaintOptions) =>
    theme.style(text, {
      fg: options.fg ? color(options.fg) : undefined,
      bg: options.bg ? color(options.bg) : undefined,
      dim: options.dim,
      bold: options.bold,
    });
  return {
    fg: (token, text) => theme.fg(token as Parameters<Theme["fg"]>[0], text),
    bold: (text) => theme.bold(text),
    paint: paintText,
    emphasis: (text) =>
      paintText(text, { fg: theme.appearance === "light" ? PALETTE.coolLight : PALETTE.cool }),
  };
}

/** Remove ANSI/OSC/APC sequences and collapse every C0/C1 control run to a space. */
export function sanitizeText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return "";
  const stripped = stripTerminalSequences(value);
  return replaceControlCharacters(stripped).replace(/\s+/g, " ").trim();
}

export function formatTokens(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "—";
  if (value < 1000) return String(Math.round(value));
  if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  if (value < 10_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return `${Math.round(value / 1_000_000)}M`;
}

export function formatBytes(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "—";
  const gib = value / 1024 ** 3;
  return `${gib >= 10 ? Math.round(gib) : gib.toFixed(1)}GiB`;
}

const RAM_UNITS = ["G", "T", "P", "E"] as const;

/** RAM shown in the compact reference form: 43G, 7.5G, 1.0T. */
export function formatRam(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "—";
  let magnitude = value / 1024 ** 3;
  let unit = 0;
  for (;;) {
    const tenths = Math.round(magnitude * 10) / 10;
    // 9.96G rounds to 10G rather than a fifth column ("10.0G").
    const rounded = tenths >= 10 ? Math.round(magnitude) : tenths;
    if (rounded < 1000 || unit === RAM_UNITS.length - 1) {
      const text = tenths >= 10 ? `${Math.round(magnitude)}` : `${tenths.toFixed(1)}`;
      return `${text}${RAM_UNITS[unit]}`;
    }
    // 999.6G rounds to 1000G; carry the unit instead of adding a fifth cell.
    magnitude /= 1024;
    unit += 1;
  }
}

export function formatRamUsage(resources: ResourceSnapshot | null): { amount: string; percent: string | null } {
  const used = resources?.memoryUsedBytes ?? null;
  const total = resources?.memoryTotalBytes ?? null;
  const usedText = formatRam(used);
  if (total === null || !Number.isFinite(total) || total <= 0) return { amount: usedText, percent: null };

  const totalText = formatRam(total);
  if (used === null || usedText === "—" || used > total) return { amount: `—/${totalText}`, percent: null };

  const usedAmount = usedText.at(-1) === totalText.at(-1) ? usedText.slice(0, -1) : usedText;
  return { amount: `${usedAmount}/${totalText}`, percent: percentLabel(used / total) };
}

/** Cache hit is this request's prompt cache ratio, never a session total. */
export function formatCacheHit(ratio: number | null | undefined): string {
  if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio < 0) return "—";
  if (ratio === 0) return "0%";
  const percent = ratio * 100;
  if (percent < 1) return "<1%";
  const rounded = Math.round(percent * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
}

/** Keep seconds precise while they fit; compact exceptionally long durations. */
export function formatTtft(ttftMs: number | null | undefined): string {
  if (typeof ttftMs !== "number" || !Number.isFinite(ttftMs) || ttftMs < 0) return "—";
  const seconds = ttftMs / 1000;
  const tenths = Math.round(seconds * 10) / 10;
  if (tenths < 100) return `${tenths.toFixed(1)}s`;
  const units = [[1, "s"], [60, "m"], [3600, "h"], [86400, "d"]] as const;
  for (const [scale, suffix] of units) {
    const rounded = Math.round(seconds / scale);
    if (rounded < 10_000 || suffix === "d") return `${rounded}${suffix}`;
  }
  return "—";
}

const RATE_UNITS = ["k", "M", "B", "T", "P", "E"] as const;

function compactRate(value: number): string {
  let magnitude = value;
  let unit = -1;
  while (magnitude >= 1000 && unit < RATE_UNITS.length - 1) {
    magnitude /= 1000;
    unit += 1;
  }
  if (unit < 0) return String(Math.round(value));
  if (magnitude >= 1000) return value.toExponential(1);
  const tenths = Math.round(magnitude * 10) / 10;
  const text = tenths >= 10 ? `${Math.round(magnitude)}` : `${tenths.toFixed(1)}`;
  return `${text}${RATE_UNITS[unit]}`;
}

export function formatThroughput(tokensPerSecond: number | null | undefined): string {
  if (typeof tokensPerSecond !== "number" || !Number.isFinite(tokensPerSecond) || tokensPerSecond < 0) {
    return "—";
  }
  if (tokensPerSecond < 100) {
    const tenths = Math.round(tokensPerSecond * 10) / 10;
    // 99.96 rounds to 100, which stays a complete integer instead of "100.0".
    return tenths >= 100 ? "100" : tenths.toFixed(1);
  }
  return compactRate(tokensPerSecond);
}

export function formatContextPercent(percent: number | null | undefined): string | null {
  if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0) return null;
  return `${percent.toFixed(1)}%`;
}

/** Shorten a path under the user's home directory, including worktree-safe paths. */
export function formatCwd(cwd: string, home: string | undefined): string {
  if (!home) return cwd;
  try {
    const resolvedCwd = resolve(cwd);
    const resolvedHome = resolve(home);
    const relativeToHome = relative(resolvedHome, resolvedCwd);
    const inside =
      relativeToHome === "" ||
      (relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
    if (!inside) return cwd;
    return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
  } catch {
    return cwd;
  }
}

function truncateMiddle(text: string, maxWidth: number): string {
  const width = Math.max(1, Math.floor(maxWidth));
  if (visibleWidth(text) <= width) return text;
  if (width <= 2) return "…";
  const total = visibleWidth(text);
  let keepLeft = Math.max(1, Math.floor((width - 1) / 2));
  let keepRight = Math.max(1, width - 1 - keepLeft);
  for (;;) {
    const left = sliceByColumn(text, 0, keepLeft);
    const right = sliceByColumn(text, total - keepRight, keepRight);
    const result = `${left}…${right}`;
    if (visibleWidth(result) <= width) return result;
    if (keepLeft >= keepRight && keepLeft > 1) keepLeft -= 1;
    else if (keepRight > 1) keepRight -= 1;
    else return "…";
  }
}

/**
 * Keep the project's leaf directory recognisable: the basename gets the budget
 * first, then a little leading context, and only then is the basename itself
 * shortened in the middle. Never wider than `width`.
 */
function formatPath(display: string, maxWidth: number): string {
  const width = Math.max(0, Math.floor(maxWidth));
  if (width === 0) return "";
  if (visibleWidth(display) <= width) return display;
  const parts = display.split(sep).filter((part, index) => !(index === 0 && part === ""));
  const base = parts.length > 1 ? parts[parts.length - 1] : "";
  if (!base) return truncateMiddle(display, width);
  const prefix = parts.slice(0, -1).join(sep);
  const baseWidth = visibleWidth(base);
  if (baseWidth >= width - 2) {
    // Reserve a two-cell prefix ("~…") so the location still reads as a path.
    const prefixBudget = Math.min(2, Math.max(0, width - 3));
    const shownBase = truncateMiddle(base, width - prefixBudget - 1);
    const shownPrefix = prefix ? truncateToWidth(prefix, prefixBudget, "…") : "";
    const separator = shownPrefix ? sep : "";
    return truncateToWidth(`${shownPrefix}${separator}${shownBase}`, width, "…");
  }
  const prefixBudget = width - baseWidth - 1;
  if (!prefix || prefixBudget < 1) return base;
  const shownPrefix = truncateToWidth(prefix, prefixBudget, "…");
  return `${shownPrefix}${sep}${base}`;
}

/** Keep parentheses paired whenever the branch is shown at all. */
function formatBranch(branch: string, maxWidth: number): string {
  const width = Math.max(0, Math.floor(maxWidth));
  const text = `(${branch})`;
  if (!branch || width < 3) return "";
  if (visibleWidth(text) <= width) return text;
  const inner = truncateToWidth(branch, width - 2, "…");
  return `(${inner})`;
}

function percentLabel(ratio: number | null | undefined): string {
  if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio < 0) return "—";
  const percent = ratio * 100;
  if (percent > 0 && percent < 1) return "<1%";
  return `${Math.round(percent)}%`;
}

function toolElapsed(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

function fitField(text: string, width: number, align: "left" | "right" = "left"): string {
  const safeWidth = Math.max(0, Math.floor(width));
  if (safeWidth === 0) return "";
  const clipped = truncateToWidth(text, safeWidth, "…");
  const padding = " ".repeat(Math.max(0, safeWidth - visibleWidth(clipped)));
  return align === "right" ? `${padding}${clipped}` : `${clipped}${padding}`;
}

/** Shared two-column inset: 2 cells normally, 1/0 only when narrow. */
export function layoutPadding(width: number): number {
  const safeWidth = Math.max(1, Math.floor(width));
  return safeWidth >= 60 ? 2 : safeWidth >= 40 ? 1 : 0;
}

/** One terminal-width line with shared inset; no custom background is painted. */
function insetLine(content: string, width: number): string {
  const safeWidth = Math.max(1, Math.floor(width));
  const padding = layoutPadding(safeWidth);
  const innerWidth = Math.max(1, safeWidth - padding * 2);
  const clipped = truncateToWidth(content, innerWidth, "…");
  const inner = clipped + " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
  return `${" ".repeat(padding)}${inner}${" ".repeat(padding)}`;
}

export interface ContextView {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface ModelView {
  provider: string;
  id: string;
}

export interface ToolView {
  name: string;
  running: boolean;
  ok: boolean;
  elapsedMs: number | null;
}

export interface HeaderView {
  host: string;
  model: ModelView | null;
  resources: ResourceSnapshot | null;
}

export interface FooterView {
  cwd: string;
  home: string | undefined;
  branch: string | null;
  totalInput: number;
  totalOutput: number;
  context: ContextView | null;
  model: ModelView | null;
  thinking: string | null;
  extensionStatuses: readonly string[];
  metrics: MetricsSnapshot | null;
  historicalCache: number | null;
  resources: ResourceSnapshot | null;
  tool: ToolView | null;
}

/** One-line header: CPU and memory usage left, host dimmed right. */
export function buildHeaderLines(view: HeaderView, width: number, style: Style): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const padding = layoutPadding(safeWidth);
  const innerWidth = Math.max(1, safeWidth - padding * 2);
  const cpu = `CPU ${fitField(percentLabel(view.resources?.cpuRatio ?? null), 4)}`;
  const { amount, percent } = formatRamUsage(view.resources);
  const compactRam = `RAM ${percent ?? amount}`;
  const fullRam = percent ? `RAM ${amount} ${percent}` : compactRam;
  // Keep the RAM reading intact even when only the percentage fits.
  const readings = [`${cpu} / ${fullRam}`, `${cpu} / ${compactRam}`, compactRam, cpu.trimEnd()];
  const left = readings.find((reading) => visibleWidth(reading) <= innerWidth) ?? "RAM";
  // Host placement follows the real left block: no fixed 19-cell assumption.
  const leftWidth = visibleWidth(left);
  const host = sanitizeText(view.host ?? "") || "unknown";
  const hostBudget = innerWidth - leftWidth - 2;
  const hostText = hostBudget >= 4 ? truncateToWidth(host, hostBudget, "…") : "";
  const gap = hostText ? Math.max(2, innerWidth - leftWidth - visibleWidth(hostText)) : 0;
  return [insetLine(
    `${style.fg("muted", left)}${" ".repeat(gap)}${hostText ? style.fg("dim", hostText) : ""}`,
    safeWidth,
  )];
}

function performanceStatus(view: FooterView): { text: string; tone: StyleToken } | null {
  const tool = view.tool;
  if (tool?.running) {
    return {
      text: `${sanitizeText(tool.name) || "tool"} ${toolElapsed(tool.elapsedMs)}`.trim(),
      tone: "accent",
    };
  }
  switch (view.metrics?.phase) {
    case "waiting":
      return { text: "等待", tone: "warning" };
    case "streaming":
      return { text: "生成中", tone: "accent" };
    case "error":
      return { text: "失败", tone: "error" };
    case "aborted":
      return { text: "已取消", tone: "warning" };
    default:
      return null;
  }
}

/** Right-side identity: model id once, then thinking/status if room remains. */
function identityRight(view: FooterView, available: number, style: Style): string | null {
  if (available < 3) return null;
  const model = sanitizeText(view.model?.id ?? "") || "—";
  const thinking = sanitizeText(view.thinking ?? "");
  const status = performanceStatus(view);
  const statusText = status ? truncateToWidth(status.text, Math.min(18, Math.max(3, available)), "…") : "";
  const thinkingSuffix = thinking ? ` · ${thinking}` : "";
  const statusSuffix = status && statusText ? ` · ${statusText}` : "";
  const modelWidth = visibleWidth(model);
  const thinkingWidth = visibleWidth(thinkingSuffix);
  const statusWidth = visibleWidth(statusSuffix);

  const render = (id: string, suffix: string, tone?: StyleToken) =>
    style.bold(style.fg("text", id)) +
    style.fg("muted", suffix) +
    (tone ? style.fg(tone, statusSuffix) : "");

  if (modelWidth + thinkingWidth + statusWidth <= available) {
    return render(model, thinkingSuffix, status?.tone);
  }
  if (statusSuffix) {
    if (modelWidth + statusWidth <= available) {
      return style.bold(style.fg("text", model)) + style.fg(status!.tone, statusSuffix);
    }
    const idBudget = available - statusWidth;
    if (idBudget >= 3) {
      return style.bold(style.fg("text", truncateToWidth(model, idBudget, "…"))) + style.fg(status!.tone, statusSuffix);
    }
    const statusBudget = Math.max(0, available - 3);
    const shortStatus = statusText ? ` · ${truncateToWidth(statusText, statusBudget, "…")}` : "";
    const shortIdBudget = available - visibleWidth(shortStatus);
    if (shortIdBudget >= 3) {
      return style.bold(style.fg("text", truncateToWidth(model, shortIdBudget, "…"))) + style.fg(status!.tone, shortStatus);
    }
  }
  if (modelWidth + thinkingWidth <= available) {
    return style.bold(style.fg("text", model)) + style.fg("muted", thinkingSuffix);
  }
  if (modelWidth <= available) return style.bold(style.fg("text", model));
  return style.bold(style.fg("text", truncateToWidth(model, available, "…")));
}

/** Footer line 1: cwd/branch left, model identity and any live state right. */
function locationLine(view: FooterView, width: number, style: Style): string {
  const safeWidth = Math.max(1, Math.floor(width));
  const padding = layoutPadding(safeWidth);
  const innerWidth = Math.max(1, safeWidth - padding * 2);
  const cwd = sanitizeText(formatCwd(view.cwd || "—", view.home)) || "—";
  const branch = sanitizeText(view.branch ?? "");
  const minLeft = innerWidth >= 72 ? 40 : innerWidth >= 52 ? 32 : innerWidth >= 36 ? 23 : 8;
  const right = identityRight(view, Math.max(4, innerWidth - minLeft - 2), style);
  const rightWidth = right ? visibleWidth(right) : 0;
  const leftWidth = Math.max(0, innerWidth - rightWidth - (right ? 2 : 0));

  const branchText = branch;
  const pathDesired = Math.min(visibleWidth(cwd), leftWidth);
  // Reserve a recognisable path first (basename + short prefix), then branch.
  const pathFloor = Math.min(
    pathDesired,
    Math.max(Math.floor(leftWidth * 0.6), Math.min(16, Math.max(0, leftWidth - 3))),
  );
  const branchNatural = branchText ? visibleWidth(branchText) + 2 : 0;
  const branchBudget = Math.min(branchNatural, Math.max(0, leftWidth - pathFloor - (branchText ? 1 : 0)));
  const branchDisplay = formatBranch(branchText, branchBudget);
  const branchPart = branchDisplay ? ` ${branchDisplay}` : "";
  const pathWidth = Math.max(1, leftWidth - visibleWidth(branchPart));
  const path = formatPath(cwd, pathWidth);
  const left = style.fg("dim", path) + style.fg("muted", branchPart);
  const gap = right ? Math.max(2, innerWidth - visibleWidth(left) - rightWidth) : 0;
  return insetLine(`${left}${" ".repeat(gap)}${right ?? ""}`, safeWidth);
}

function contextPercentText(view: FooterView): string {
  const windowSize = view.context?.contextWindow ?? 0;
  const percent =
    view.context?.percent ??
    (view.context?.tokens !== null && view.context?.tokens !== undefined && windowSize > 0
      ? (view.context.tokens / windowSize) * 100
      : null);
  return formatContextPercent(percent) ?? "—";
}

/** Footer line 2: compact performance group left, context percentage right. */
function statsLine(view: FooterView, width: number, style: Style): string {
  const safeWidth = Math.max(1, Math.floor(width));
  const padding = layoutPadding(safeWidth);
  const innerWidth = Math.max(1, safeWidth - padding * 2);
  const metrics = view.metrics;
  const cache = metrics && metrics.phase !== "idle" ? metrics.cacheHitRate : view.historicalCache;
  const showTiming = metrics?.phase === "complete";
  const throughput = metrics?.tokensPerSecond;
  const measured =
    showTiming && typeof throughput === "number" && Number.isFinite(throughput) && throughput >= 0;
  const tpsText = measured ? formatThroughput(throughput) : "—";
  const tpsValue = fitField(tpsText, Math.max(4, visibleWidth(tpsText)), "right");
  const tps = (measured ? style.emphasis(tpsValue) : style.fg("muted", tpsValue)) +
    style.fg("muted", " tok/s");
  const ttftText = showTiming ? formatTtft(metrics?.ttftMs) : "—";
  const ttft = style.fg("muted", "TTFT ") +
    style.fg("text", fitField(ttftText, Math.max(5, visibleWidth(ttftText))));
  const cacheGroup = style.fg("muted", "缓存 ") +
    style.fg("text", fitField(formatCacheHit(cache), 5));
  const context = style.fg("muted", "上下文 ") + style.fg("text", contextPercentText(view));
  const separator = "  ";
  const contextWidth = visibleWidth(context);

  for (const groups of [[tps, ttft, cacheGroup], [tps, ttft], [tps], []]) {
    const left = groups.join(separator);
    const leftWidth = visibleWidth(left);
    if (leftWidth === 0) return insetLine(context, safeWidth);
    if (leftWidth + 2 + contextWidth <= innerWidth) {
      return insetLine(`${left}${" ".repeat(innerWidth - leftWidth - contextWidth)}${context}`, safeWidth);
    }
  }
  return insetLine(context, safeWidth);
}

export function buildFooterLines(view: FooterView, width: number, style: Style): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const lines = [
    locationLine(view, safeWidth, style),
    statsLine(view, safeWidth, style),
  ];
  const statuses = view.extensionStatuses
    .map((status) => sanitizeText(status))
    .filter((status) => status.length > 0);
  if (statuses.length > 0) {
    lines.push(insetLine(style.fg("dim", statuses.join(" · ")), safeWidth));
  }
  return lines;
}
