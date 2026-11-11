import assert from "node:assert/strict";
import test from "node:test";
import { parseColor, stripTerminalSequences, styleText } from "@earendil-works/pi-tui";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { registerNativeStatus, type RuntimeDeps } from "../index.ts";
import type { ResourceSnapshot } from "../resources.ts";

const resources: ResourceSnapshot = {
  host: "test-nuc",
  cpuRatio: 0.25,
  memoryUsedBytes: 8 * 1024 ** 3,
  memoryTotalBytes: 16 * 1024 ** 3,
  cpuHistory: [0.1, 0.25],
  memoryHistory: [0.5],
};

const theme = {
  fg: (_token: string, text: string) => text,
  bold: (text: string) => text,
  getColorMode: () => "truecolor",
  style: (text: string, options: { fg?: unknown; bg?: unknown; dim?: boolean; bold?: boolean }) =>
    styleText(
      text,
      {
        fg: options.fg as ReturnType<typeof parseColor> | undefined,
        bg: options.bg as ReturnType<typeof parseColor> | undefined,
        dim: options.dim,
        bold: options.bold,
      },
      "truecolor",
    ),
} as unknown as Theme;

const tui = { requestRender: () => {} };

interface FakeTimers {
  intervals: Map<number, (() => void) | undefined>;
  timeouts: Map<number, (() => void) | undefined>;
  timers: RuntimeDeps["timers"];
}

function fakeTimers(): FakeTimers {
  let next = 1;
  const intervals = new Map<number, (() => void) | undefined>();
  const timeouts = new Map<number, (() => void) | undefined>();
  return {
    intervals,
    timeouts,
    timers: {
      setInterval(callback) {
        const id = next++;
        intervals.set(id, callback);
        return id;
      },
      clearInterval(handle) {
        intervals.delete(handle as number);
      },
      setTimeout(callback) {
        const id = next++;
        timeouts.set(id, callback);
        return id;
      },
      clearTimeout(handle) {
        timeouts.delete(handle as number);
      },
    },
  };
}

function fakePi(flag = false) {
  const handlers = new Map<string, ((event: any, ctx: any) => unknown)[]>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const flags = new Map<string, unknown>([["native-status-off", flag]]);
  const api = {
    on(name: string, handler: (event: any, ctx: any) => unknown) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
      return () => {
        handlers.set(name, (handlers.get(name) ?? []).filter((item) => item !== handler));
      };
    },
    registerCommand(name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) {
      commands.set(name, options);
    },
    registerFlag(name: string, options: { default?: unknown }) {
      if (!flags.has(name)) flags.set(name, options.default);
    },
    getFlag(name: string) {
      return flags.get(name);
    },
  } as unknown as ExtensionAPI;

  return {
    api,
    commands,
    async emit(name: string, event: unknown, ctx: unknown) {
      for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
    },
  };
}

function footerData(branch = "main", statuses: readonly string[] = ["编译中"]) {
  return {
    getGitBranch: () => branch,
    getExtensionStatuses: () =>
      new Map(statuses.map((status, index) => [`extension-${index}`, status])),
    getAvailableProviderCount: () => 1,
    onBranchChange: () => () => {},
  };
}

function fakeContext(
  mode: "tui" | "rpc" | "print" | "json" = "tui",
  options: {
    entries?: unknown[];
    branch?: unknown[];
    usage?: { tokens: number | null; contextWindow: number; percent: number | null };
  } = {},
) {
  const calls = {
    headers: [] as unknown[],
    footers: [] as unknown[],
    notifications: [] as string[],
  };
  const ctx = {
    mode,
    cwd: "/home/demo/project",
    model: { provider: "mock", id: "mock-chat", contextWindow: 128000 },
    thinkingLevel: "high",
    ui: {
      theme,
      setHeader(factory: unknown) {
        calls.headers.push(factory);
      },
      setFooter(factory: unknown) {
        calls.footers.push(factory);
      },
      setStatus() {},
      notify(message: string) {
        calls.notifications.push(message);
      },
    },
    sessionManager: {
      getEntries: () => options.entries ?? [],
      getBranch: () => options.branch ?? options.entries ?? [],
    },
    getContextUsage: () => options.usage,
  };
  return {
    ctx: ctx as unknown as ExtensionContext,
    commandCtx: ctx as unknown as ExtensionCommandContext,
    calls,
  };
}

function setup(options: { flag?: boolean; branch?: string; statuses?: readonly string[] } = {}) {
  const pi = fakePi(options.flag ?? false);
  const timers = fakeTimers();
  let now = 0;
  const deps: Partial<RuntimeDeps> = {
    now: () => now,
    sampler: { reset() {}, sample: () => resources },
    timers: timers.timers,
  };
  const runtime = registerNativeStatus(pi.api, deps);
  const data = footerData(options.branch, options.statuses);
  return {
    pi,
    runtime,
    timers,
    data,
    setNow(value: number) {
      now = value;
    },
    components(ctx: ReturnType<typeof fakeContext>) {
      const headerFactory = ctx.calls.headers.at(-1) as
        | ((tui: unknown, theme: Theme) => { render(width: number): string[] })
        | undefined;
      const footerFactory = ctx.calls.footers.at(-1) as
        | ((tui: unknown, theme: Theme, data: unknown) => { render(width: number): string[] })
        | undefined;
      return {
        header(width = 120): string[] {
          assert.ok(headerFactory, "header factory missing");
          return headerFactory(tui, theme).render(width);
        },
        footer(width = 120): string[] {
          assert.ok(footerFactory, "footer factory missing");
          return footerFactory(tui, theme, data).render(width);
        },
      };
    },
  };
}

function plain(lines: string[]): string {
  return stripTerminalSequences(lines.join("\n"));
}

function assistantMessage(usage: Record<string, number>, stopReason = "stop") {
  return {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    api: "mock",
    provider: "mock",
    model: "mock-chat",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      ...usage,
    },
    stopReason,
    timestamp: 0,
  };
}

const start = { type: "session_start", reason: "startup" } as const;

test("the extension factory starts no timer and touches no UI", () => {
  const harness = setup();
  const session = fakeContext();
  assert.equal(harness.timers.intervals.size, 0);
  assert.equal(session.calls.headers.length, 0);
  assert.equal(session.calls.footers.length, 0);
  assert.equal(harness.runtime.isRunning, false);
});

test("RPC mode never installs UI, starts a timer, or notifies", async () => {
  const harness = setup();
  const session = fakeContext("rpc", { usage: { tokens: 10, contextWindow: 100, percent: 10 } });
  await harness.pi.emit("session_start", start, session.ctx);
  await harness.pi.emit(
    "before_provider_request",
    { type: "before_provider_request", payload: { private: "never read" } },
    session.ctx,
  );
  await harness.pi.emit(
    "message_update",
    { type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "x" } },
    session.ctx,
  );
  assert.equal(harness.timers.intervals.size, 0);
  assert.equal(session.calls.headers.length, 0);
  assert.equal(session.calls.footers.length, 0);
  assert.deepEqual(session.calls.notifications, []);
  assert.equal(harness.runtime.isRunning, false);
  await harness.pi.commands.get("native-status")!.handler("details", session.commandCtx);
  assert.deepEqual(session.calls.notifications, []);
});

test("TUI session_start installs native components and one sampling timer", async () => {
  const harness = setup();
  const session = fakeContext("tui", {
    usage: { tokens: 1000, contextWindow: 128000, percent: 0.78 },
    entries: [{ type: "message", message: assistantMessage({ input: 1000, output: 50 }) }],
  });
  await harness.pi.emit("session_start", start, session.ctx);
  assert.equal(harness.timers.intervals.size, 1);
  assert.equal(session.calls.headers.length, 1);
  assert.equal(session.calls.footers.length, 1);
  assert.equal(harness.runtime.isRunning, true);

  const components = harness.components(session);
  assert.match(plain(components.header()), /test-nuc/);
  assert.match(plain(components.footer()), /home\/demo\/project|~\/project/);
  assert.match(plain(components.footer()), /mock-chat/);
  assert.match(plain(components.footer()), /编译中/);
  assert.match(plain(components.footer()), / · high/);
  assert.match(plain(components.footer()), /上下文 0\.8%/);
});

test("tool time is separate from generation timing and never changes TPS", async () => {
  const harness = setup();
  const session = fakeContext("tui");
  const components = () => harness.components(session);

  await harness.pi.emit("session_start", start, session.ctx);
  harness.setNow(1000);
  await harness.pi.emit(
    "before_provider_request",
    { type: "before_provider_request", payload: {} },
    session.ctx,
  );
  harness.setNow(1200);
  await harness.pi.emit(
    "message_update",
    {
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi", partial: {} },
    },
    session.ctx,
  );
  harness.setNow(2500);
  await harness.pi.emit(
    "message_end",
    { type: "message_end", message: assistantMessage({ input: 1000, cacheRead: 9000, output: 100 }, "toolUse") },
    session.ctx,
  );

  const completed = plain(components().footer());
  assert.match(completed, /TTFT 0\.2s/);
  assert.match(completed, /76\.9 tok\/s/);
  assert.match(completed, /缓存 90%/);

  harness.setNow(2600);
  await harness.pi.emit(
    "tool_execution_start",
    { type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: {} },
    session.ctx,
  );
  harness.setNow(3000);
  const running = plain(components().footer());
  assert.match(running, /read 0\.4s/);
  assert.match(running, /76\.9 tok\/s/);

  await harness.pi.emit(
    "tool_execution_end",
    { type: "tool_execution_end", toolCallId: "t1", toolName: "read", result: {}, isError: false, durationMs: 400 },
    session.ctx,
  );
  const afterTool = plain(components().footer());
  assert.doesNotMatch(afterTool, /read/);
  assert.match(afterTool, /76\.9 tok\/s/);
});

test("a new request clears the previous request's TTFT and TPS immediately", async () => {
  const harness = setup();
  const session = fakeContext("tui");
  const components = () => harness.components(session);

  await harness.pi.emit("session_start", start, session.ctx);
  harness.setNow(1000);
  await harness.pi.emit("before_provider_request", { type: "before_provider_request", payload: {} }, session.ctx);
  harness.setNow(1100);
  await harness.pi.emit(
    "message_update",
    {
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "a", partial: {} },
    },
    session.ctx,
  );
  harness.setNow(2100);
  await harness.pi.emit(
    "message_end",
    { type: "message_end", message: assistantMessage({ input: 100, output: 50 }) },
    session.ctx,
  );
  assert.match(plain(components().footer()), /50\.0 tok\/s/);

  harness.setNow(3000);
  await harness.pi.emit("before_provider_request", { type: "before_provider_request", payload: {} }, session.ctx);
  const cleared = plain(components().footer());
  assert.match(cleared, /等待/);
  assert.match(cleared, /TTFT —/);
  assert.match(cleared, /— tok\/s/);
  assert.match(cleared, /缓存 —/);

  harness.setNow(3100);
  await harness.pi.emit(
    "message_update",
    {
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "b", partial: {} },
    },
    session.ctx,
  );
  harness.setNow(4100);
  await harness.pi.emit(
    "message_end",
    { type: "message_end", message: assistantMessage({ input: 200, output: 100 }) },
    session.ctx,
  );
  assert.match(plain(components().footer()), /100 tok\/s/);
});

test("model_select clears prior speed and cache but keeps a running tool", async () => {
  const harness = setup();
  const session = fakeContext("tui");
  const components = () => harness.components(session);

  await harness.pi.emit("session_start", start, session.ctx);
  harness.setNow(1000);
  await harness.pi.emit("before_provider_request", { type: "before_provider_request", payload: {} }, session.ctx);
  harness.setNow(1100);
  await harness.pi.emit(
    "message_update",
    {
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "a", partial: {} },
    },
    session.ctx,
  );
  harness.setNow(2100);
  await harness.pi.emit(
    "message_end",
    {
      type: "message_end",
      message: assistantMessage({ input: 1000, cacheRead: 9000, output: 50 }),
    },
    session.ctx,
  );
  assert.match(plain(components().footer()), /50\.0 tok\/s/);
  assert.match(plain(components().footer()), /缓存 90%/);

  harness.setNow(2200);
  await harness.pi.emit(
    "tool_execution_start",
    { type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: {} },
    session.ctx,
  );
  harness.setNow(2300);
  await harness.pi.emit(
    "model_select",
    {
      type: "model_select",
      model: { provider: "other", id: "model-b" },
      previousModel: { provider: "mock", id: "mock-chat" },
      source: "set",
    },
    session.ctx,
  );

  const switched = plain(components().footer());
  assert.match(switched, /model-b/);
  assert.match(switched, /TTFT —/);
  assert.match(switched, /— tok\/s/);
  assert.match(switched, /缓存 —/);
  assert.match(switched, /read 0\.1s/);

  harness.setNow(3000);
  await harness.pi.emit("before_provider_request", { type: "before_provider_request", payload: {} }, session.ctx);
  harness.setNow(3100);
  await harness.pi.emit(
    "message_update",
    {
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "b", partial: {} },
    },
    session.ctx,
  );
  harness.setNow(4100);
  await harness.pi.emit(
    "message_end",
    {
      type: "message_end",
      message: assistantMessage({ input: 200, output: 100 }),
    },
    session.ctx,
  );
  const switchedAfterNewRequest = plain(components().footer());
  assert.match(switchedAfterNewRequest, /TTFT 0\.1s/);
  assert.match(switchedAfterNewRequest, /100 tok\/s/);
  assert.match(switchedAfterNewRequest, /缓存 0%/);
});

test("failed requests show no successful TTFT or TPS", async () => {
  const harness = setup();
  const session = fakeContext("tui");
  const components = () => harness.components(session);

  await harness.pi.emit("session_start", start, session.ctx);
  harness.setNow(1000);
  await harness.pi.emit("before_provider_request", { type: "before_provider_request", payload: {} }, session.ctx);
  harness.setNow(1100);
  await harness.pi.emit(
    "message_update",
    {
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x", partial: {} },
    },
    session.ctx,
  );
  harness.setNow(1500);
  await harness.pi.emit(
    "message_end",
    {
      type: "message_end",
      message: assistantMessage({ input: 100, output: 10 }, "error"),
    },
    session.ctx,
  );
  const text = plain(components().footer());
  assert.match(text, /失败/);
  assert.match(text, /TTFT —/);
  assert.match(text, /— tok\/s/);
});

test("a resumed session shows its last usage cache but no restored timing", async () => {
  const harness = setup();
  const session = fakeContext("tui", {
    usage: { tokens: 10000, contextWindow: 128000, percent: 7.8 },
    entries: [
      {
        type: "message",
        message: assistantMessage({ input: 1000, cacheRead: 9000, cacheWrite: 0, output: 100 }),
      },
    ],
  });
  await harness.pi.emit("session_start", { type: "session_start", reason: "resume" }, session.ctx);
  const text = plain(harness.components(session).footer());
  assert.match(text, /缓存 90%/);
  assert.match(text, /TTFT —/);
  assert.match(text, /— tok\/s/);
  assert.doesNotMatch(text, /↑|↓|128k/);
});

test("restored cache comes from the active branch while totals stay session-wide", async () => {
  const harness = setup();
  const active = {
    type: "message",
    message: assistantMessage({ input: 1000, cacheRead: 9000, cacheWrite: 0, output: 100 }),
  };
  const otherBranch = {
    type: "message",
    message: assistantMessage({ input: 100, cacheRead: 25, cacheWrite: 0, output: 10 }),
  };
  const session = fakeContext("tui", {
    usage: { tokens: 10000, contextWindow: 128000, percent: 7.8 },
    // The sibling branch is later in the session file and must not win.
    entries: [active, otherBranch],
    branch: [active],
  });
  await harness.pi.emit("session_start", { type: "session_start", reason: "resume" }, session.ctx);
  const footer = plain(harness.components(session).footer());
  assert.match(footer, /缓存 90%/);
  assert.doesNotMatch(footer, /缓存 20%/);

  await harness.pi.commands.get("native-status")!.handler("details", session.commandCtx);
  const details = session.calls.notifications.at(-1) ?? "";
  assert.match(details, /缓存: 90%/);
  assert.match(details, /累计: ↑1\.1k ↓110/);
});

test("active branch without usage does not borrow another branch's cache", async () => {
  const harness = setup();
  const otherBranch = {
    type: "message",
    message: assistantMessage({ input: 100, cacheRead: 25, cacheWrite: 0, output: 10 }),
  };
  const session = fakeContext("tui", {
    usage: { tokens: 10000, contextWindow: 128000, percent: 7.8 },
    entries: [otherBranch],
    branch: [{ type: "message", message: { role: "user", content: "hi" } }],
  });
  await harness.pi.emit("session_start", { type: "session_start", reason: "resume" }, session.ctx);
  assert.match(plain(harness.components(session).footer()), /缓存 —/);

  await harness.pi.commands.get("native-status")!.handler("details", session.commandCtx);
  const details = session.calls.notifications.at(-1) ?? "";
  assert.match(details, /缓存: —/);
  assert.match(details, /累计: ↑100 ↓10/);
});

test("compaction leaves context tokens unknown until the next response", async () => {
  const harness = setup();
  const session = fakeContext("tui", {
    usage: { tokens: null, contextWindow: 128000, percent: null },
  });
  await harness.pi.emit("session_start", start, session.ctx);
  await harness.pi.emit(
    "session_compact",
    { type: "session_compact", compactionEntry: { usage: { input: 100, output: 20 } } },
    session.ctx,
  );
  const text = plain(harness.components(session).footer());
  assert.match(text, /上下文 —/);
});

test("session_shutdown clears the timer and removes the custom components", async () => {
  const harness = setup();
  const session = fakeContext("tui");
  await harness.pi.emit("session_start", start, session.ctx);
  harness.components(session).footer();
  assert.equal(harness.timers.intervals.size, 1);

  await harness.pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, session.ctx);
  assert.equal(harness.timers.intervals.size, 0);
  assert.equal(harness.timers.timeouts.size, 0);
  assert.equal(harness.runtime.isRunning, false);
  assert.equal(harness.runtime.sampleTimerHandle, null);
});

test("/native-status details reports collected numbers without chat content", async () => {
  const harness = setup();
  const session = fakeContext("tui", {
    usage: { tokens: 1000, contextWindow: 128000, percent: 0.78 },
  });
  await harness.pi.emit("session_start", start, session.ctx);
  harness.setNow(1000);
  await harness.pi.emit(
    "before_provider_request",
    { type: "before_provider_request", payload: { private: "never read" } },
    session.ctx,
  );
  harness.setNow(1200);
  await harness.pi.emit(
    "message_update",
    {
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi", partial: {} },
    },
    session.ctx,
  );
  harness.setNow(2500);
  await harness.pi.emit(
    "message_end",
    { type: "message_end", message: assistantMessage({ input: 1000, cacheRead: 9000, output: 100 }) },
    session.ctx,
  );

  await harness.pi.commands.get("native-status")!.handler("details", session.commandCtx);
  const text = session.calls.notifications.at(-1) ?? "";
  assert.match(text, /native-status 详情/);
  assert.match(text, /主机: test-nuc/);
  assert.match(text, /模型: mock-chat/);
  assert.match(text, /Provider: mock/);
  assert.match(text, /Thinking: high/);
  assert.match(text, /CPU: 25%/);
  assert.match(text, /RAM 已用\/总量: 8\.0\/16G \(50%\)/);
  assert.match(text, /上下文: 1\.0k \/ 128k \(0\.8%\)/);
  assert.match(text, /累计: ↑1\.0k ↓100/);
  assert.match(text, /缓存: 90%/);
  assert.match(text, /TTFT: 0\.2s/);
  assert.match(text, /速度: 76\.9 tok\/s/);
  assert.doesNotMatch(text, /never read|payload|args|prompt/);
});

test("/native-status off restores defaults; on restarts sampling", async () => {
  const harness = setup();
  const session = fakeContext("tui");
  await harness.pi.emit("session_start", start, session.ctx);
  const command = harness.pi.commands.get("native-status");
  assert.ok(command);

  await command!.handler("off", session.commandCtx);
  assert.equal(harness.timers.intervals.size, 0);
  assert.equal(harness.runtime.isRunning, false);
  assert.equal(session.calls.headers.at(-1), undefined);
  assert.equal(session.calls.footers.at(-1), undefined);
  assert.match(session.calls.notifications.at(-1) ?? "", /已关闭/);

  await command!.handler("on", session.commandCtx);
  assert.equal(harness.timers.intervals.size, 1);
  assert.equal(harness.runtime.isRunning, true);
  assert.equal(typeof session.calls.headers.at(-1), "function");
  assert.match(session.calls.notifications.at(-1) ?? "", /已开启/);
});

test("--native-status-off suppresses startup until explicitly enabled", async () => {
  const harness = setup({ flag: true });
  const session = fakeContext("tui");
  await harness.pi.emit("session_start", start, session.ctx);
  assert.equal(harness.timers.intervals.size, 0);
  assert.equal(harness.runtime.isRunning, false);
  assert.equal(session.calls.headers.at(-1), undefined);

  await harness.pi.commands.get("native-status")!.handler("on", session.commandCtx);
  assert.equal(harness.timers.intervals.size, 1);
  assert.equal(harness.runtime.isRunning, true);
  assert.match(session.calls.notifications.join("\n"), /native-status-off/);
});
