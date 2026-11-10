import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseColor, stripTerminalSequences, styleText, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Theme } from "@earendil-works/pi-coding-agent";
import { RequestMetrics, type MetricsSnapshot } from "../metrics.ts";
import type { ResourceSnapshot } from "../resources.ts";
import {
  buildFooterLines,
  buildHeaderLines,
  formatBytes,
  formatCacheHit,
  formatCwd,
  formatRam,
  formatTokens,
  formatThroughput,
  formatTtft,
  layoutPadding,
  nearestPaletteIndex,
  PALETTE,
  sanitizeText,
  styleFromTheme,
  type FooterView,
  type HeaderView,
  type Style,
} from "../render.ts";

const ansiStyle: Style = {
  fg: (_token, text) => `\x1b[36m${text}\x1b[0m`,
  bold: (text) => `\x1b[1m${text}\x1b[0m`,
  paint: (text, options) =>
    styleText(
      text,
      {
        fg: options.fg ? parseColor(options.fg) : undefined,
        bg: options.bg ? parseColor(options.bg) : undefined,
        dim: options.dim,
        bold: options.bold,
      },
      "truecolor",
    ),
  emphasis: (text) => styleText(text, { fg: parseColor(PALETTE.cool) }, "truecolor"),
};

function themeForMode(mode: "truecolor" | "256color"): Theme {
  return {
    fg: (_token: string, text: string) => styleText(text, { fg: parseColor("#e6e4ee") }, mode),
    bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
    getColorMode: () => mode,
    style: (text: string, options: Parameters<typeof styleText>[1]) => styleText(text, options, mode),
  } as unknown as Theme;
}

function resources(): ResourceSnapshot {
  return {
    host: "nuc",
    cpuRatio: 0.42,
    memoryUsedBytes: 12.5 * 1024 ** 3,
    memoryTotalBytes: 32 * 1024 ** 3,
    cpuHistory: [0, 0.2, 0.5, 1, null],
    memoryHistory: [0.1, 0.3, 0.6],
  };
}

function completedMetrics(cacheRead = 9000, output = 100): MetricsSnapshot {
  const metrics = new RequestMetrics();
  metrics.begin(0, "provider-request");
  metrics.firstDelta(100, "text", "x");
  metrics.finish(1100, { input: 1000, cacheRead, cacheWrite: 0, output });
  return metrics.snapshot();
}

function activeMetrics(): MetricsSnapshot {
  const metrics = new RequestMetrics();
  metrics.begin(0, "provider-request");
  metrics.firstDelta(100, "text", "x");
  return metrics.snapshot(500);
}

function view(overrides: Partial<FooterView> = {}): FooterView {
  return {
    cwd: "/home/demo/projects/pi-native-status",
    home: "/home/demo",
    branch: "main",
    totalInput: 12345,
    totalOutput: 678,
    context: { tokens: 12345, contextWindow: 128000, percent: 9.64 },
    model: { provider: "deepseek", id: "deepseek-chat" },
    thinking: "high",
    extensionStatuses: ["编译中", "cache warm"],
    metrics: completedMetrics(),
    historicalCache: null,
    resources: resources(),
    tool: null,
    ...overrides,
  };
}

const header: HeaderView = {
  host: "nuc",
  model: { provider: "deepseek", id: "deepseek-chat" },
  resources: resources(),
};

const hostile = "\x1b]0;pwned\x07\x1b[2J\u0000\u0007";

function plain(lines: string[]): string {
  return stripTerminalSequences(lines.join("\n"));
}

test("token, byte, cache, TTFT and throughput formatting keep unknown values unknown", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(12_345), "12k");
  assert.equal(formatTokens(1_500_000), "1.5M");
  assert.equal(formatTokens(null), "—");
  assert.equal(formatBytes(32 * 1024 ** 3), "32GiB");
  assert.equal(formatBytes(null), "—");
  assert.equal(formatRam(43 * 1024 ** 3), "43G");
  assert.equal(formatRam(null), "—");
  assert.equal(formatCacheHit(0), "0%");
  assert.equal(formatCacheHit(0.004), "<1%");
  assert.equal(formatCacheHit(0.9), "90%");
  assert.equal(formatCacheHit(0.976), "97.6%");
  assert.equal(formatCacheHit(null), "—");
  assert.equal(formatTtft(1234), "1.2s");
  assert.equal(formatTtft(null), "—");
  assert.equal(formatThroughput(12.34), "12.3");
  assert.equal(formatThroughput(null), "—");
});

test("custom cool accent uses the xterm grey-teal, never deep blue", () => {
  assert.equal(nearestPaletteIndex(PALETTE.cool), 115);
  assert.notEqual(nearestPaletteIndex(PALETTE.cool), 17);
  const truecolor = styleFromTheme(themeForMode("truecolor")).paint("x", { fg: PALETTE.cool });
  assert.match(truecolor, /38;2;139;209;194/);
  const mode256 = styleFromTheme(themeForMode("256color")).paint("x", { fg: PALETTE.cool });
  assert.match(mode256, /38;5;115/);
  assert.doesNotMatch(mode256, /38;5;17(?!\d)/);
});

test("light theme throughput accent is readable against a white page", () => {
  const sdk = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
  const raw = JSON.parse(readFileSync(join(sdk, "modes/interactive/theme/light.json"), "utf8")) as {
    vars?: Record<string, string>;
    colors: Record<string, string>;
  };
  const resolve = (value: string) => raw.vars?.[value] ?? value;
  const colors = Object.fromEntries(Object.entries(raw.colors).map(([key, value]) => [key, resolve(value)]));
  const light = new Theme(colors as never, colors as never, "truecolor", { appearance: "light" });
  const painted = styleFromTheme(light).emphasis("x");
  const match = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(painted);
  assert.ok(match, `expected truecolor resource accent, got ${JSON.stringify(painted)}`);
  const rgb = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  const luminance = (values: readonly number[]) => {
    const channels = values.map((value) => {
      const channel = value / 255;
      return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const lightLuminance = luminance([255, 255, 255]);
  const accentLuminance = luminance(rgb);
  const contrast = (lightLuminance + 0.05) / (accentLuminance + 0.05);
  assert.ok(contrast >= 4.5, `resource accent contrast ${contrast.toFixed(2)} is too low`);
  assert.match(styleFromTheme(themeForMode("truecolor")).emphasis("x"), /38;2;139;209;194/);
});

test("styled truncation retains the full reset used by Pi", () => {
  const styled = ansiStyle.fg("dim", "demo-laptop-with-long-name.local");
  const clipped = truncateToWidth(styled, 18, "…");
  assert.match(clipped, /\x1b\[0m/);
  assert.equal(visibleWidth(clipped), 18);
});

test("dynamic text drops OSC, ANSI and control characters", () => {
  assert.equal(sanitizeText(`a${hostile}b\n c`), "a b c");
  assert.equal(sanitizeText("正常 文本\t值"), "正常 文本 值");
  assert.equal(sanitizeText(undefined), "");
});

test("cwd is home-shortened without leaving the home directory", () => {
  assert.equal(formatCwd("/home/demo/a/b", "/home/demo"), "~/a/b");
  assert.equal(formatCwd("/home/demo", "/home/demo"), "~");
  assert.equal(formatCwd("/tmp/a", "/home/demo"), "/tmp/a");
});

test("header is one compact line with stable CPU/RAM fields and host on the right", () => {
  const nine = plain(buildHeaderLines(
    { ...header, resources: { ...resources(), cpuRatio: 0.09 } },
    80,
    ansiStyle,
  )).split("\n")[0];
  const full = plain(buildHeaderLines(
    { ...header, resources: { ...resources(), cpuRatio: 1 } },
    80,
    ansiStyle,
  )).split("\n")[0];
  assert.equal(nine.indexOf("RAM"), full.indexOf("RAM"));
  assert.equal(nine.length, full.length);
  assert.match(nine, /CPU/);
  assert.match(nine, /RAM 13G/);
  assert.match(nine, /nuc\s*$/);
  assert.doesNotMatch(nine, /Model:|[⣀-⣿]/);
  assert.equal(layoutPadding(80), 2);
});

test("footer is two lines at every target width, with the model only once", () => {
  for (const width of [40, 60, 80, 120, 160]) {
    const lines = buildFooterLines(view({ extensionStatuses: [] }), width, ansiStyle);
    assert.equal(lines.length, 2);
    const [first, second] = plain(lines).split("\n");
    assert.doesNotMatch(first, /CPU|RAM|↑|↓/);
    assert.doesNotMatch(second, /CPU|RAM|↑|↓|128k|deepseek/);
    assert.match(first, /~/);
    assert.match(first, /\(main\)/);
    if (width >= 60) assert.match(first, /pi-native-status/);
    assert.match(first, /deepseek-chat/);
    assert.doesNotMatch(first, /\(deepseek\)/);
    assert.match(second, /tok\/s/);
    assert.match(second, /TTFT/);
    assert.match(second, /上下文/);
    if (width >= 60) assert.match(second, /缓存/);
    else assert.doesNotMatch(second, /缓存/);

    const combined = plain(buildHeaderLines(header, width, ansiStyle)) + first + second;
    assert.equal(combined.match(/deepseek/g)?.length, 1);
    for (const line of lines) assert.ok(visibleWidth(line) <= width);
  }
});

test("only a measured completed throughput is emphasised, never an unknown reading", () => {
  const theme = themeForMode("truecolor");
  const accent = /38;2;139;209;194/;
  const headerLine = buildHeaderLines(header, 80, styleFromTheme(theme)).join("\n");
  assert.doesNotMatch(headerLine, accent);

  const complete = buildFooterLines(view({ extensionStatuses: [] }), 120, styleFromTheme(theme)).join("\n");
  assert.match(complete, accent);

  const streaming = buildFooterLines(
    view({ metrics: activeMetrics(), extensionStatuses: [] }),
    120,
    styleFromTheme(theme),
  ).join("\n");
  assert.doesNotMatch(streaming, accent);

  const unknown = buildFooterLines(
    view({
      metrics: { ...completedMetrics(), tokensPerSecond: null },
      extensionStatuses: [],
    }),
    120,
    styleFromTheme(theme),
  ).join("\n");
  assert.doesNotMatch(unknown, accent);
  assert.match(plain([unknown]), /— tok\/s/);
});

test("model id is bold while thinking and units stay quiet", () => {
  const first = buildFooterLines(view({ extensionStatuses: [] }), 120, ansiStyle)[0];
  assert.match(first, /\x1b\[1m\x1b\[36mdeepseek-chat\x1b\[0m/);
  assert.doesNotMatch(first, /\x1b\[1m\x1b\[36mhigh/);
  const second = buildFooterLines(view({ extensionStatuses: [] }), 120, ansiStyle)[1];
  assert.match(second, / tok\/s/);
  assert.match(second, /TTFT /);
});

test("unknown context stays explicit at narrow widths and cache is the first omission", () => {
  const lines = buildFooterLines(
    view({
      context: { tokens: null, contextWindow: 128000, percent: null },
      extensionStatuses: [],
    }),
    40,
    ansiStyle,
  );
  const text = plain(lines);
  assert.equal(lines.length, 2);
  assert.match(text, /上下文 —/);
  assert.doesNotMatch(text, /缓存/);
});

test("live states replace the right side without adding a persistent line", () => {
  const completed = plain(buildFooterLines(view({ extensionStatuses: [] }), 120, ansiStyle));
  assert.doesNotMatch(completed, /生成中|等待|失败|已取消|read/);

  const streaming = plain(buildFooterLines(view({ metrics: activeMetrics(), extensionStatuses: [] }), 120, ansiStyle));
  assert.match(streaming, /生成中/);
  assert.match(streaming, /tok\/s/);

  const failedMetrics = new RequestMetrics();
  failedMetrics.begin(0, "provider-request");
  failedMetrics.firstDelta(50, "text", "x");
  failedMetrics.finish(500, { input: 100, cacheRead: 0, cacheWrite: 0, output: 10 }, "error");
  const failed = plain(buildFooterLines(view({
    metrics: failedMetrics.snapshot(),
    tool: { name: "read", running: true, ok: true, elapsedMs: 1200 },
    extensionStatuses: [],
  }), 120, ansiStyle));
  assert.match(failed, /read 1\.2s/);
  assert.equal(buildFooterLines(view({
    metrics: failedMetrics.snapshot(),
    tool: { name: "read", running: true, ok: true, elapsedMs: 1200 },
    extensionStatuses: [],
  }), 120, ansiStyle).length, 2);
});

test("extension status adds exactly one optional footer line", () => {
  const lines = buildFooterLines(view({ extensionStatuses: ["build:ok"] }), 80, ansiStyle);
  assert.equal(lines.length, 3);
  assert.match(plain(lines), /build:ok/);
});

test("header and footer stay inside 40/60/80/120/160 with CJK, ANSI and hostile labels", () => {
  const hostileView = view({
    cwd: `/home/demo/项目/${"很长目录".repeat(12)}${hostile}`,
    branch: `feature/${"分支".repeat(8)}${hostile}`,
    model: { provider: `deep${hostile}`, id: `deepseek-${"超长模型".repeat(10)}${hostile}` },
    thinking: `high${hostile}`,
    extensionStatuses: [`编译中${hostile}`, `a\nb\tc${hostile}`],
    tool: { name: `ba${hostile}sh`, running: true, ok: true, elapsedMs: 2500 },
  });
  const hostileHeader: HeaderView = {
    host: `nuc${hostile}`,
    model: { provider: `deep${hostile}`, id: `seek-${"模型".repeat(20)}${hostile}` },
    resources: resources(),
  };
  for (const width of [40, 60, 80, 120, 160]) {
    const headerLines = buildHeaderLines(hostileHeader, width, ansiStyle);
    const footerLines = buildFooterLines(hostileView, width, ansiStyle);
    assert.equal(headerLines.length, 1);
    assert.ok(footerLines.length >= 2);
    for (const line of [...headerLines, ...footerLines]) {
      assert.ok(visibleWidth(line) <= width, `overflow at ${width}: ${JSON.stringify(line)}`);
      assert.ok(!line.includes("\u0007"));
      assert.ok(!line.includes("\u0000"));
      assert.ok(!line.includes("\x1b]"));
      assert.ok(!line.includes("\x1b[2J"));
    }
  }
});
