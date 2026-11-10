/**
 * Pi CLI native status bar.
 *
 * TUI only: a single CPU/RAM/host header and a two-line footer showing
 * location, model, context, and measured request performance. Secondary
 * metrics are available through /native-status details. The factory starts
 * nothing; TUI sampling stops on shutdown, reload, or native-status off.
 */
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  MessageEndEvent,
  MessageUpdateEvent,
  ModelSelectEvent,
  SessionCompactEvent,
  SessionCompactFailedEvent,
  SessionStartEvent,
  ThinkingLevelSelectEvent,
  ToolExecutionEndEvent,
  ToolExecutionStartEvent,
  TurnStartEvent,
  BeforeProviderRequestEvent,
  ReadonlyFooterDataProvider,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { FixedHeaderSlot, type HeaderPlacement } from "./fixed-header.ts";
import { RequestMetrics, type RequestOutcome } from "./metrics.ts";
import { ResourceSampler, type ResourceSnapshot } from "./resources.ts";
import {
  buildFooterLines,
  buildHeaderLines,
  formatCacheHit,
  formatContextPercent,
  formatRam,
  formatThroughput,
  formatTokens,
  formatTtft,
  sanitizeText,
  styleFromTheme,
  type FooterView,
  type ModelView,
  type Style,
  type ToolView,
} from "./render.ts";

const SAMPLE_INTERVAL_MS = 1000;
const RENDER_THROTTLE_MS = 200;
const FLAG = "native-status-off";
const STATUS_KEY = "native-status";
const COMMAND = "native-status";

interface RuntimeTimers {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface RuntimeDeps {
  now(): number;
  sampler: Pick<ResourceSampler, "sample" | "reset">;
  timers: RuntimeTimers;
}

function unref(handle: unknown): void {
  const maybe = handle as { unref?: () => void } | null;
  if (maybe && typeof maybe.unref === "function") maybe.unref();
}

const defaultTimers: RuntimeTimers = {
  setInterval(callback, ms) {
    const handle = setInterval(callback, ms);
    unref(handle);
    return handle;
  },
  clearInterval(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
  setTimeout(callback, ms) {
    const handle = setTimeout(callback, ms);
    unref(handle);
    return handle;
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

function defaultDeps(): RuntimeDeps {
  return {
    now: () => performance.now(),
    sampler: new ResourceSampler(),
    timers: defaultTimers,
  };
}

interface UsageCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

function readUsage(value: unknown): UsageCounts | null {
  if (value === null || typeof value !== "object") return null;
  const usage = value as Record<string, unknown>;
  const number = (key: string) => {
    const field = usage[key];
    return typeof field === "number" && Number.isFinite(field) && field >= 0 ? field : 0;
  };
  return {
    input: number("input"),
    output: number("output"),
    cacheRead: number("cacheRead"),
    cacheWrite: number("cacheWrite"),
  };
}

function addUsage(total: { input: number; output: number }, usage: UsageCounts | null): void {
  if (!usage) return;
  total.input += usage.input;
  total.output += usage.output;
}

function outcomeFor(stopReason: string): RequestOutcome {
  if (stopReason === "error") return "error";
  if (stopReason === "aborted") return "aborted";
  return "complete";
}

function isAssistant(message: unknown): message is AssistantMessage {
  return Boolean(message) && typeof message === "object" && (message as { role?: unknown }).role === "assistant";
}

/** Only the assistant's first non-empty model output starts the clock. */
function firstDeltaKind(event: MessageUpdateEvent): { kind: "text" | "thinking" | "toolcall"; delta: string } | null {
  const update = event.assistantMessageEvent;
  if (update.type === "text_delta" || update.type === "thinking_delta" || update.type === "toolcall_delta") {
    const delta = typeof update.delta === "string" ? update.delta : "";
    return delta.length > 0
      ? { kind: update.type === "text_delta" ? "text" : update.type === "thinking_delta" ? "thinking" : "toolcall", delta }
      : null;
  }
  return null;
}

interface RunningTool {
  name: string;
  startedAtMs: number;
}

interface LastTool {
  name: string;
  ok: boolean;
  durationMs: number | null;
}

export class NativeStatusRuntime {
  private readonly pi: ExtensionAPI;
  private readonly deps: RuntimeDeps;
  private readonly metrics = new RequestMetrics();
  private countedMessages = new WeakSet<object>();

  private ctx: ExtensionContext | null = null;
  private footerData: ReadonlyFooterDataProvider | null = null;
  private style: Style | null = null;
  private tui: { requestRender(): void } | null = null;
  private running = false;
  private enabled = false;
  private sampleTimer: unknown = null;
  private renderTimer: unknown = null;
  private lastRenderAt = Number.NEGATIVE_INFINITY;
  private readonly renderListeners = new Set<() => void>();
  private branchUnsubscribe: (() => void) | null = null;

  private resources: ResourceSnapshot | null = null;
  private readonly totals = { input: 0, output: 0 };
  private historicalCache: number | null = null;
  private hasRequestThisSession = false;
  private contextUnknown = false;
  private firstOutputSeen = false;
  private model: ModelView | null = null;
  private thinking: string | null = null;
  private readonly runningTools = new Map<string, RunningTool>();
  private lastTool: LastTool | null = null;
  private headerSlot: FixedHeaderSlot | null = null;
  private readonly headerWarnings = new Set<HeaderPlacement>();

  constructor(pi: ExtensionAPI, deps: Partial<RuntimeDeps> = {}) {
    this.pi = pi;
    this.deps = { ...defaultDeps(), ...deps };
  }

  /** Register events, command and flag. Starts no timer and touches no UI. */
  bind(): void {
    this.pi.registerFlag(FLAG, {
      description: "Disable the native status bar for this run",
      type: "boolean",
      default: false,
    });
    this.pi.registerCommand(COMMAND, {
      description: "原生状态栏：/native-status [on|off|details]",
      handler: (args, ctx) => this.command(args, ctx),
    });

    this.pi.on("session_start", (event, ctx) => this.onSessionStart(event, ctx));
    this.pi.on("session_shutdown", () => this.stop(false));
    this.pi.on("turn_start", (event, ctx) => this.onTurnStart(event, ctx));
    this.pi.on("before_provider_request", (event, ctx) => this.onProviderRequest(event, ctx));
    this.pi.on("message_update", (event, ctx) => this.onMessageUpdate(event, ctx));
    this.pi.on("message_end", (event, ctx) => this.onMessageEnd(event, ctx));
    this.pi.on("tool_execution_start", (event) => this.onToolStart(event));
    this.pi.on("tool_execution_end", (event) => this.onToolEnd(event));
    this.pi.on("model_select", (event, ctx) => this.onModelSelect(event, ctx));
    this.pi.on("thinking_level_select", (event) => this.onThinkingLevel(event));
    this.pi.on("session_before_compact", () => this.onBeforeCompact());
    this.pi.on("session_compact", (event, ctx) => this.onCompact(event, ctx));
    this.pi.on("session_compact_failed", () => this.onCompactFailed());
  }

  /** Visible for tests and for `/native-status` diagnostics. */
  get isRunning(): boolean {
    return this.running;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  get sampleTimerHandle(): unknown {
    return this.sampleTimer;
  }

  private now(): number {
    return this.deps.now();
  }

  private onSessionStart(_event: SessionStartEvent, ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") {
      this.stop(false);
      return;
    }
    if (this.pi.getFlag(FLAG) === true) {
      // Explicitly remove a component left by a previously enabled session.
      this.stop(true);
      return;
    }
    // A new/resumed/forked session replaces the previous one in this instance.
    this.stop(false);
    this.ctx = ctx;
    this.enabled = true;
    this.model = toModelView(ctx.model);
    this.thinking = ctx.thinkingLevel ?? null;
    this.contextUnknown = false;
    this.hasRequestThisSession = false;
    this.firstOutputSeen = false;
    this.metrics.reset();
    this.runningTools.clear();
    this.lastTool = null;
    this.countedMessages = new WeakSet<object>();
    this.refreshTotals(ctx, true);
    this.samplerReset();
    this.running = true;
    this.installUi(ctx);
    this.sample();
    this.startSampling();
    this.invalidate();
  }

  private installUi(ctx: ExtensionContext): void {
    ctx.ui.setHeader((tui, theme) => this.headerComponent(tui, theme));
    ctx.ui.setFooter((tui, theme, footerData) => this.footerComponent(tui, theme, footerData));
  }

  private headerComponent(
    tui: TUI,
    theme: Theme,
  ): { render(width: number): string[]; invalidate(): void; dispose(): void } {
    this.tui = tui;
    this.style = styleFromTheme(theme);
    const listener = () => tui.requestRender();
    this.renderListeners.add(listener);
    this.headerSlot?.dispose();
    const slot = new FixedHeaderSlot({
      render: (width) => this.renderHeader(width),
      invalidate: () => {},
    });
    this.headerSlot = slot;
    slot.attach(tui);
    return {
      render: (width: number) => slot.sync() === "fixed" ? [] : this.renderHeader(width),
      invalidate: () => {},
      dispose: () => {
        slot.dispose();
        if (this.headerSlot === slot) this.headerSlot = null;
        this.renderListeners.delete(listener);
        if (this.tui === tui) this.tui = null;
      },
    };
  }

  private footerComponent(
    tui: { requestRender(): void },
    theme: Theme,
    footerData: ReadonlyFooterDataProvider,
  ): { render(width: number): string[]; invalidate(): void; dispose(): void } {
    this.tui = tui;
    this.style = styleFromTheme(theme);
    this.footerData = footerData;
    this.branchUnsubscribe?.();
    this.branchUnsubscribe = footerData.onBranchChange(() => this.invalidate());
    const listener = () => tui.requestRender();
    this.renderListeners.add(listener);
    return {
      render: (width: number) => this.renderFooter(width),
      invalidate: () => {},
      dispose: () => {
        this.renderListeners.delete(listener);
        if (this.tui === tui) this.tui = null;
      },
    };
  }

  private renderHeader(width: number): string[] {
    try {
      return buildHeaderLines(
        {
          host: this.resources?.host ?? "unknown",
          model: this.model,
          resources: this.resources,
        },
        width,
        this.style ?? identityStyle,
      );
    } catch {
      return [truncateToWidth("Pi 原生状态", width)];
    }
  }

  private footerView(): FooterView {
    const statuses = this.footerData
      ? Array.from(this.footerData.getExtensionStatuses().values())
      : [];
    return {
      cwd: this.ctx?.cwd ?? "",
      home: process.env.HOME,
      branch: this.footerData?.getGitBranch() ?? null,
      totalInput: this.totals.input,
      totalOutput: this.totals.output,
      context: this.contextView(),
      model: this.model,
      thinking: this.thinking,
      extensionStatuses: statuses,
      metrics: this.metrics.snapshot(this.now()),
      historicalCache: this.hasRequestThisSession ? null : this.historicalCache,
      resources: this.resources,
      tool: this.toolView(),
    };
  }

  private renderFooter(width: number): string[] {
    try {
      return buildFooterLines(this.footerView(), width, this.style ?? identityStyle);
    } catch {
      return [truncateToWidth("Pi 原生状态 渲染失败", width)];
    }
  }

  private detailsText(view: FooterView): string {
    const metrics = view.metrics;
    const cache = metrics && metrics.phase !== "idle" ? metrics.cacheHitRate : view.historicalCache;
    const showTiming = metrics?.phase === "complete";
    const context = view.context;
    const windowSize = context?.contextWindow ?? 0;
    const cpu = view.resources?.cpuRatio;
    const cpuText = typeof cpu === "number" && Number.isFinite(cpu) ? `${Math.round(cpu * 100)}%` : "—";
    return [
      "native-status 详情",
      `顶部布局: ${this.headerSlot?.describe() ?? "未挂载"}`,
      `主机: ${sanitizeText(view.resources?.host ?? "") || "—"}`,
      `模型: ${sanitizeText(view.model?.id ?? "") || "—"}`,
      `Provider: ${sanitizeText(view.model?.provider ?? "") || "—"}`,
      `Thinking: ${sanitizeText(view.thinking ?? "") || "—"}`,
      `CPU: ${cpuText}`,
      `RAM: ${formatRam(view.resources?.memoryUsedBytes)} / ${formatRam(view.resources?.memoryTotalBytes)}`,
      `上下文: ${formatTokens(context?.tokens)} / ${windowSize > 0 ? formatTokens(windowSize) : "—"} (${formatContextPercent(context?.percent) ?? "—"})`,
      `累计: ↑${formatTokens(view.totalInput)} ↓${formatTokens(view.totalOutput)}`,
      `缓存: ${formatCacheHit(cache)}`,
      `TTFT: ${showTiming ? formatTtft(metrics?.ttftMs) : "—"}`,
      `速度: ${showTiming ? formatThroughput(metrics?.tokensPerSecond) : "—"} tok/s`,
    ].join("\n");
  }

  private contextView(): FooterView["context"] {
    let usage: { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
    try {
      usage = this.ctx?.getContextUsage();
    } catch {
      usage = undefined;
    }
    const window = usage?.contextWindow ?? this.modelContextWindow();
    const tokens = this.contextUnknown ? null : usage?.tokens ?? null;
    const percent = tokens === null
      ? null
      : usage?.percent ?? (window > 0 ? (tokens / window) * 100 : null);
    return { tokens, contextWindow: window, percent };
  }

  private modelContextWindow(): number {
    const model = this.ctx?.model;
    return model && Number.isFinite(model.contextWindow) && model.contextWindow > 0 ? model.contextWindow : 0;
  }

  private toolView(): ToolView | null {
    const running = Array.from(this.runningTools.values());
    const active = running[running.length - 1];
    if (active) {
      return {
        name: active.name,
        running: true,
        ok: true,
        elapsedMs: Math.max(0, this.now() - active.startedAtMs),
      };
    }
    if (!this.lastTool) return null;
    return {
      name: this.lastTool.name,
      running: false,
      ok: this.lastTool.ok,
      elapsedMs: this.lastTool.durationMs,
    };
  }

  private onTurnStart(event: TurnStartEvent, ctx: ExtensionContext): void {
    if (!this.running || event.type !== "turn_start") return;
    this.beginRequest("turn-start", ctx);
  }

  private onProviderRequest(event: BeforeProviderRequestEvent, ctx: ExtensionContext): void {
    if (!this.running || event.type !== "before_provider_request") return;
    // The payload is deliberately never read.
    this.beginRequest("provider-request", ctx);
  }

  private beginRequest(source: "turn-start" | "provider-request", ctx: ExtensionContext): void {
    this.ctx = ctx;
    this.metrics.begin(this.now(), source);
    this.hasRequestThisSession = true;
    this.contextUnknown = false;
    this.firstOutputSeen = false;
    this.runningTools.clear();
    this.lastTool = null;
    this.invalidate();
  }

  private onMessageUpdate(event: MessageUpdateEvent, ctx: ExtensionContext): void {
    if (!this.running || event.type !== "message_update") return;
    if (!isAssistant(event.message)) return;
    this.ctx = ctx;
    if (this.firstOutputSeen) return;
    const first = firstDeltaKind(event);
    if (!first) return;
    this.firstOutputSeen = true;
    this.metrics.firstDelta(this.now(), first.kind, first.delta);
    this.invalidate();
  }

  private onMessageEnd(event: MessageEndEvent, ctx: ExtensionContext): void {
    if (!this.running || event.type !== "message_end") return;
    this.ctx = ctx;

    if (isAssistant(event.message)) {
      const message = event.message;
      this.metrics.finish(this.now(), message.usage, outcomeFor(message.stopReason));
      this.countUsage(message);
      this.historicalCacheForMessage(message);
      if (message.stopReason !== "error" && message.stopReason !== "aborted") {
        this.contextUnknown = false;
      }
      this.invalidate();
      return;
    }

    if (event.message && typeof event.message === "object" && (event.message as { role?: unknown }).role === "toolResult") {
      this.countUsage(event.message as unknown as { usage?: unknown });
      this.invalidate();
    }
  }

  private onToolStart(event: ToolExecutionStartEvent): void {
    if (!this.running || event.type !== "tool_execution_start") return;
    this.runningTools.delete(event.toolCallId);
    this.runningTools.set(event.toolCallId, { name: event.toolName, startedAtMs: this.now() });
    this.invalidate();
  }

  private onToolEnd(event: ToolExecutionEndEvent): void {
    if (!this.running || event.type !== "tool_execution_end") return;
    const started = this.runningTools.get(event.toolCallId);
    this.runningTools.delete(event.toolCallId);
    this.lastTool = {
      name: event.toolName,
      ok: !event.isError,
      durationMs:
        typeof event.durationMs === "number" && Number.isFinite(event.durationMs) && event.durationMs >= 0
          ? event.durationMs
          : started
            ? Math.max(0, this.now() - started.startedAtMs)
            : null,
    };
    this.invalidate();
  }

  private onModelSelect(event: ModelSelectEvent, ctx: ExtensionContext): void {
    if (!this.running) return;
    this.ctx = ctx;
    this.model = toModelView(event.model);
    this.thinking = ctx.thinkingLevel ?? this.thinking;
    // A model switch invalidates the previous model's request performance and
    // historical cache. Running tools are session activity, so keep them.
    this.metrics.reset();
    this.historicalCache = null;
    this.hasRequestThisSession = false;
    this.firstOutputSeen = false;
    this.invalidate();
  }

  private onThinkingLevel(event: ThinkingLevelSelectEvent): void {
    if (!this.running) return;
    this.thinking = event.level;
    this.invalidate();
  }

  private onBeforeCompact(): void {
    if (!this.running) return;
    // After compaction tokens are unknown until the next provider response.
    this.contextUnknown = true;
    this.metrics.reset();
    this.invalidate();
  }

  private onCompact(event: SessionCompactEvent, ctx: ExtensionContext): void {
    if (!this.running) return;
    this.ctx = ctx;
    this.contextUnknown = true;
    this.countUsage(event.compactionEntry);
    this.invalidate();
  }

  private onCompactFailed(): void {
    if (!this.running) return;
    // A failed compaction leaves the existing context in place.
    this.contextUnknown = false;
    this.invalidate();
  }

  private countUsage(message: object): void {
    if (this.countedMessages.has(message)) return;
    this.countedMessages.add(message);
    const usage = readUsage((message as { usage?: unknown }).usage);
    addUsage(this.totals, usage);
  }

  private historicalCacheForMessage(message: AssistantMessage): void {
    const usage = readUsage(message.usage);
    if (!usage) return;
    const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
    if (prompt > 0) this.historicalCache = usage.cacheRead / prompt;
  }

  private refreshTotals(ctx: ExtensionContext, includeHistorical: boolean): void {
    this.totals.input = 0;
    this.totals.output = 0;
    if (includeHistorical) this.historicalCache = null;
    let entries: unknown[];
    try {
      entries = ctx.sessionManager.getEntries();
    } catch {
      return;
    }
    // Totals stay session-wide, including usage that lives on other branches.
    for (const raw of entries) {
      if (!raw || typeof raw !== "object") continue;
      const entry = raw as Record<string, unknown>;
      if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") {
        addUsage(this.totals, readUsage(entry.usage));
        continue;
      }
      if (entry.type !== "message") continue;
      const message = entry.message;
      if (!message || typeof message !== "object") continue;
      addUsage(this.totals, readUsage((message as { usage?: unknown }).usage));
    }
    if (includeHistorical) this.historicalCache = this.branchCache(ctx);
  }

  /** Restored cache comes only from the active leaf path, never a sibling branch. */
  private branchCache(ctx: ExtensionContext): number | null {
    let branch: unknown[];
    try {
      branch = ctx.sessionManager.getBranch();
    } catch {
      return null;
    }
    let latest: number | null = null;
    for (const raw of branch) {
      if (!raw || typeof raw !== "object") continue;
      const entry = raw as Record<string, unknown>;
      if (entry.type !== "message") continue;
      const message = entry.message;
      if (!message || typeof message !== "object") continue;
      if ((message as { role?: unknown }).role !== "assistant") continue;
      const usage = readUsage((message as { usage?: unknown }).usage);
      if (!usage) continue;
      const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
      if (prompt > 0) latest = usage.cacheRead / prompt;
    }
    return latest;
  }

  private samplerReset(): void {
    this.deps.sampler.reset();
  }

  private sample(): void {
    if (!this.running) return;
    this.updateHeaderPlacement();
    try {
      this.resources = this.deps.sampler.sample();
    } catch {
      this.resources = null;
    }
    this.invalidate();
  }

  private updateHeaderPlacement(): void {
    const state = this.headerSlot?.sync();
    if (!state || state === "fixed" || state === "detached" || this.headerWarnings.has(state)) return;
    this.headerWarnings.add(state);
    this.ctx?.ui.notify(
      state === "regular"
        ? "固定顶部需要 fullscreen 模式；可在 /settings 中切换 TUI mode。当前使用普通 header。"
        : "当前宿主布局无法识别，已保留普通 header；可用 /native-status details 查看顶部布局状态。",
      "warning",
    );
  }

  private startSampling(): void {
    if (this.sampleTimer !== null) return;
    this.sampleTimer = this.deps.timers.setInterval(() => {
      if (!this.running) return;
      this.sample();
    }, SAMPLE_INTERVAL_MS);
  }

  private stopSampling(): void {
    if (this.sampleTimer === null) return;
    this.deps.timers.clearInterval(this.sampleTimer);
    this.sampleTimer = null;
  }

  private invalidate(): void {
    if (!this.running) return;
    const elapsed = this.now() - this.lastRenderAt;
    if (elapsed >= RENDER_THROTTLE_MS) {
      this.flushRender();
      return;
    }
    if (this.renderTimer !== null) return;
    this.renderTimer = this.deps.timers.setTimeout(() => {
      this.renderTimer = null;
      if (this.running) this.flushRender();
    }, Math.max(0, RENDER_THROTTLE_MS - elapsed));
  }

  private flushRender(): void {
    if (!this.running) return;
    this.lastRenderAt = this.now();
    for (const listener of this.renderListeners) {
      try {
        listener();
      } catch {
        // A disposed TUI must not break the sampling loop or event handling.
      }
    }
  }

  private stop(restore: boolean): void {
    const ctx = this.ctx;
    this.running = false;
    this.headerSlot?.dispose();
    this.headerSlot = null;
    this.headerWarnings.clear();
    this.stopSampling();
    if (this.renderTimer !== null) {
      this.deps.timers.clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }
    this.renderListeners.clear();
    this.branchUnsubscribe?.();
    this.branchUnsubscribe = null;
    this.tui = null;
    this.footerData = null;
    this.ctx = null;
    this.metrics.reset();
    this.runningTools.clear();
    this.lastTool = null;
    this.firstOutputSeen = false;
    this.hasRequestThisSession = false;
    this.contextUnknown = false;
    this.enabled = false;
    this.deps.sampler.reset();
    this.resources = null;
    this.totals.input = 0;
    this.totals.output = 0;
    this.historicalCache = null;
    this.lastRenderAt = Number.NEGATIVE_INFINITY;
    if (restore && ctx?.mode === "tui") {
      try {
        ctx.ui.setHeader(undefined);
        ctx.ui.setFooter(undefined);
        ctx.ui.setStatus(STATUS_KEY, undefined);
      } catch {
        // Shutting down; there is nothing useful to report.
      }
    }
  }

  private async command(args: string, ctx: ExtensionCommandContext): Promise<void> {
    // RPC/print/json keep their default UI and state untouched.
    if (ctx.mode !== "tui") return;
    const action = args.trim().toLowerCase();
    if (action === "off") {
      if (!this.running) {
        ctx.ui.notify("native-status 已经是关闭状态", "info");
        return;
      }
      this.stop(true);
      ctx.ui.notify("native-status 已关闭，默认 header/footer 已恢复", "info");
      return;
    }
    if (action === "on") {
      if (this.running) {
        ctx.ui.notify("native-status 已在运行", "info");
        return;
      }
      if (this.pi.getFlag(FLAG) === true) {
        ctx.ui.notify("本次运行以 --native-status-off 启动；可再次执行 /native-status on", "warning");
      }
      this.enabled = true;
      this.ctx = ctx;
      this.model = toModelView(ctx.model);
      this.thinking = ctx.thinkingLevel ?? null;
      this.refreshTotals(ctx, true);
      this.running = true;
      this.installUi(ctx);
      this.samplerReset();
      this.startSampling();
      this.sample();
      this.invalidate();
      ctx.ui.notify("native-status 已开启", "info");
      return;
    }
    if (action === "details") {
      if (!this.running) {
        ctx.ui.notify("native-status 未开启", "info");
        return;
      }
      this.ctx = ctx;
      ctx.ui.notify(this.detailsText(this.footerView()), "info");
      return;
    }
    if (action !== "") {
      ctx.ui.notify("用法：/native-status [on|off|details]", "warning");
      return;
    }
    ctx.ui.notify(
      [
        "native-status（Pi 原生状态栏）",
        "/native-status on | off | details",
        "CPU/RAM 为运行 Pi 的主机（RAM=total-free，含缓存）；上下文来自 ctx.getContextUsage()。",
        "缓存=本次 cacheRead/(input+cacheRead+cacheWrite)；≈tok/s=provider output/首字到消息结束；TTFT=请求→首个非空输出片段。未知显示 —，不估算 token、不显示 5h/7d 额度。",
      ].join("\n"),
      "info",
    );
  }
}

function toModelView(model: { provider?: unknown; id?: unknown } | undefined): ModelView | null {
  if (!model) return null;
  const provider = typeof model.provider === "string" ? model.provider : "";
  const id = typeof model.id === "string" ? model.id : "";
  if (!provider && !id) return null;
  return { provider, id };
}

const identityStyle: Style = {
  fg: (_token, text) => text,
  bold: (text) => text,
  paint: (text) => text,
  emphasis: (text) => text,
};

export function registerNativeStatus(pi: ExtensionAPI, deps: Partial<RuntimeDeps> = {}): NativeStatusRuntime {
  const runtime = new NativeStatusRuntime(pi, deps);
  runtime.bind();
  return runtime;
}

export default function (pi: ExtensionAPI): void {
  registerNativeStatus(pi);
}
