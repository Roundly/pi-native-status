/**
 * Reproducible v0.4.1 compact previews from the real builders.
 *
 * One header line plus two footer lines, with clearly mock data and truecolor
 * ANSI. Writes normal, long-content, busy and light-theme states under artifacts/.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseColor, styleText, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { RequestMetrics } from "../metrics.ts";
import { buildFooterLines, buildHeaderLines, styleFromTheme, type FooterView, type HeaderView } from "../render.ts";

const ROOT = dirname(fileURLToPath(new URL(".", import.meta.url)));

const TOKEN_COLORS: Record<string, string> = {
  accent: "#dd8dbb",
  muted: "#8c96a0",
  dim: "#6f7780",
  text: "#e6e4ee",
  success: "#8bd1c2",
  warning: "#e8c49b",
  error: "#e89b9b",
};

const theme = {
  fg: (token: string, text: string) =>
    styleText(text, { fg: parseColor(TOKEN_COLORS[token] ?? TOKEN_COLORS.text) }, "truecolor"),
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  getColorMode: () => "truecolor",
  style: (text: string, options: Parameters<typeof styleText>[1]) => styleText(text, options, "truecolor"),
} as unknown as Theme;

const style = styleFromTheme(theme);

const LIGHT_TOKEN_COLORS: Record<string, string> = {
  accent: "#a34d7a",
  muted: "#6b7280",
  dim: "#8a8f98",
  text: "#23232b",
  success: "#2f6f68",
  warning: "#9a641d",
  error: "#b23b3b",
};

const lightTheme = {
  fg: (token: string, text: string) =>
    styleText(text, { fg: parseColor(LIGHT_TOKEN_COLORS[token] ?? LIGHT_TOKEN_COLORS.text) }, "truecolor"),
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  getColorMode: () => "truecolor",
  appearance: "light",
  style: (text: string, options: Parameters<typeof styleText>[1]) => styleText(text, options, "truecolor"),
} as unknown as Theme;

const lightStyle = styleFromTheme(lightTheme);

function completedMetrics(): RequestMetrics {
  const metrics = new RequestMetrics();
  metrics.begin(0, "provider-request");
  metrics.firstDelta(2500, "text", "x");
  metrics.finish(5011, { input: 200, cacheRead: 8200, cacheWrite: 0, output: 110 });
  return metrics;
}

function streamingMetrics(): RequestMetrics {
  const metrics = new RequestMetrics();
  metrics.begin(0, "provider-request");
  metrics.firstDelta(900, "text", "x");
  return metrics;
}

const resources = {
  host: "nuc-lab",
  cpuRatio: 0.26,
  memoryUsedBytes: 43 * 1024 ** 3,
  memoryTotalBytes: 64 * 1024 ** 3,
  cpuHistory: [0.08, 0.12, 0.18, 0.22, 0.31, 0.28, 0.34, 0.26],
  memoryHistory: [0.58, 0.6, 0.61, 0.62, 0.63, 0.64, 0.66, 0.67],
};

const normalHeader: HeaderView = {
  host: resources.host,
  model: { provider: "deepseek", id: "deepseek-v3.2-exp" },
  resources,
};

const normalFooter: FooterView = {
  cwd: "/Users/demo/Projects/pi-native-status",
  home: "/Users/demo",
  branch: "main",
  totalInput: 3800,
  totalOutput: 116,
  context: { tokens: 3932, contextWindow: 262144, percent: 1.5 },
  model: { provider: "deepseek", id: "deepseek-v3.2-exp" },
  thinking: "high",
  extensionStatuses: [],
  metrics: completedMetrics().snapshot(),
  historicalCache: null,
  resources,
  tool: null,
};

const longHeader: HeaderView = {
  host: "demo-laptop-with-long-name.local",
  model: { provider: "deepseek", id: "deepseek-v3.2-exp-ultra-long-context-preview" },
  resources: {
    ...resources,
    cpuRatio: 1,
    memoryUsedBytes: 61.5 * 1024 ** 3,
  },
};

const longFooter: FooterView = {
  ...normalFooter,
  cwd: "/Users/demo/Projects/一个非常长的项目目录/pi-native-status-with-a-very-long-worktree-name",
  branch: "feature/very-long-branch-name-for-layout",
  model: { provider: "deepseek", id: "deepseek-v3.2-exp-ultra-long-context-preview" },
  context: { tokens: 111_111, contextWindow: 262144, percent: 42.4 },
};

const busyFooter: FooterView = {
  ...normalFooter,
  metrics: streamingMetrics().snapshot(1800),
  tool: { name: "read", running: true, ok: true, elapsedMs: 1200 },
};

function render(header: HeaderView, footer: FooterView, width: number, activeStyle = style): string {
  return [
    ...buildHeaderLines(header, width, activeStyle),
    "",
    ...buildFooterLines(footer, width, activeStyle),
  ].join("\n") + "\n";
}

function plain(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

mkdirSync(join(ROOT, "artifacts"), { recursive: true });
const scenarios = [
  { name: "normal", header: normalHeader, footer: normalFooter, widths: [40, 60, 80, 120, 160] },
  { name: "long", header: longHeader, footer: longFooter, widths: [80, 120] },
  { name: "busy", header: normalHeader, footer: busyFooter, widths: [80, 120] },
  {
    name: "light",
    header: normalHeader,
    footer: normalFooter,
    widths: [80, 120],
    light: true,
  },
];

for (const scenario of scenarios) {
  for (const width of scenario.widths) {
    const file = scenario.name === "normal" ? `visual-${width}.ansi` : `visual-${width}-${scenario.name}.ansi`;
    const text = render(scenario.header, scenario.footer, width, scenario.light ? lightStyle : style);
    writeFileSync(join(ROOT, "artifacts", file), text, "utf8");
    for (const line of plain(text).split("\n").slice(0, -1)) {
      if (visibleWidth(line) > width) throw new Error(`${file} overflow at ${width}: ${visibleWidth(line)}`);
    }
    console.log(`--- ${scenario.name} · ${width} columns ---`);
    console.log(plain(text));
  }
}
