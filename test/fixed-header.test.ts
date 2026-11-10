import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  ScrollView,
  TuiAltScreen,
  TuiMainScreen,
  VStack,
  stripTerminalSequences,
  truncateToWidth,
  type Component,
  type Terminal,
  type TUI,
} from "@earendil-works/pi-tui";
import { FixedHeaderSlot } from "../fixed-header.ts";

class FakeTerminal implements Terminal {
  columns = 80;
  rows = 14;
  kittyProtocolActive = false;
  writes: string[] = [];
  private onResize: (() => void) | undefined;

  start(_onInput: (data: string) => void, onResize: () => void): void { this.onResize = onResize; }
  stop(): void { this.onResize = undefined; }
  async drainInput(): Promise<void> {}
  write(data: string): void { this.writes.push(data); }
  moveBy(_lines: number): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(_title: string): void {}
  setProgress(_active: boolean): void {}
  setProgramStatus(_status: Parameters<Terminal["setProgramStatus"]>[0]): void {}

  resize(columns: number, rows: number): void {
    this.columns = columns;
    this.rows = rows;
    this.onResize?.();
  }
}

function linesComponent(lines: readonly string[]): Component {
  return {
    render: (width) => lines.map((line) => truncateToWidth(line, width)),
    invalidate: () => {},
  };
}

const headerText = "CPU 25% / RAM 8G";
const header = () => linesComponent([headerText]);

/** This is the only private read in these tests, on instances they own. */
function rootOf(tui: TUI): Component | undefined {
  return (tui as unknown as { layoutRoot?: Component }).layoutRoot;
}

function host(t: TestContext) {
  const terminal = new FakeTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const document = linesComponent(Array.from({ length: 40 }, (_, index) => `BODY_${String(index).padStart(3, "0")}`));
  const transcript = new ScrollView(document, { primary: true, follow: "end", scrollbar: "hidden" });
  const dock = new VStack([linesComponent(["EDITOR", "FOOTER"])]);
  const root = new VStack([
    { component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
    { component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
  ]);
  tui.setLayoutRoot(root);
  tui.start();
  t.after(() => tui.stop({ preserveScreen: true }));
  return { tui, terminal, root, transcript, dock };
}

function frame(tui: TuiAltScreen): string[] {
  tui.renderNow();
  return tui.getScreenLines().map(stripTerminalSequences);
}

function assertPinned(tui: TuiAltScreen): string[] {
  const screen = frame(tui);
  assert.equal(screen[0].trim(), headerText);
  assert.equal(screen.filter((line) => line.includes(headerText)).length, 1);
  assert.equal(screen.at(-2)?.trim(), "EDITOR");
  assert.equal(screen.at(-1)?.trim(), "FOOTER");
  return screen;
}

test("fixed header reserves row zero while the original primary transcript scrolls and resizes", (t) => {
  const h = host(t);
  const slot = new FixedHeaderSlot(header());
  t.after(() => slot.dispose());
  assert.equal(slot.attach(h.tui), "fixed");
  const wrapper = rootOf(h.tui);
  assert.ok(wrapper instanceof VStack);
  assert.equal(wrapper.children[1], h.root);
  assert.equal(h.root.children[0], h.transcript);
  assert.equal(h.root.children[1], h.dock);
  assert.ok(assertPinned(h.tui).some((line) => line.includes("BODY_039")));

  h.tui.scrollToTop();
  assert.equal(assertPinned(h.tui)[1].trim(), "BODY_000", "first body line must not be covered");
  h.tui.scrollBy(8);
  assert.equal(assertPinned(h.tui)[1].trim(), "BODY_008");
  assert.equal(h.transcript.scrollTop, 8, "TUI scrolling must still target the original primary ScrollView");

  h.terminal.resize(40, 9);
  const resized = assertPinned(h.tui);
  assert.equal(resized.length, 9);
  assert.equal(resized[1].trim(), "BODY_008");
  assert.equal(h.transcript.scrollTop, 8);
  h.tui.scrollToBottom();
  assert.ok(assertPinned(h.tui).some((line) => line.includes("BODY_039")));
});

test("dispose restores the exact host viewport root and can be repeated", (t) => {
  const h = host(t);
  const slot = new FixedHeaderSlot(header());
  slot.attach(h.tui);
  assertPinned(h.tui);
  slot.dispose();
  assert.equal(rootOf(h.tui), h.root);
  assert.equal(slot.state, "detached");
  assert.ok(frame(h.tui).every((line) => !line.includes(headerText)));
  slot.dispose();
  assert.equal(rootOf(h.tui), h.root);
});

test("repeated attach keeps one header and never nests the original viewport", (t) => {
  const h = host(t);
  const slot = new FixedHeaderSlot(header());
  t.after(() => slot.dispose());
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal(slot.attach(h.tui), "fixed");
    const wrapper = rootOf(h.tui);
    assert.ok(wrapper instanceof VStack);
    assert.equal(wrapper.children[1], h.root);
    assert.equal(h.root.children[0], h.transcript);
    assertPinned(h.tui);
  }
});

test("dispose leaves a root installed by another extension untouched", (t) => {
  const h = host(t);
  const slot = new FixedHeaderSlot(header());
  slot.attach(h.tui);
  const foreignRoot = new VStack([linesComponent(["FOREIGN_ROOT"])]);
  h.tui.setLayoutRoot(foreignRoot);
  slot.dispose();
  assert.equal(rootOf(h.tui), foreignRoot);
  assert.equal(slot.state, "detached");
});

test("unknown viewport structures are rejected without changing their root", (t) => {
  const h = host(t);
  const secondary = new ScrollView(linesComponent(["not primary"]), { primary: false });
  const unknownRoots: (Component | undefined)[] = [
    linesComponent(["unknown"]),
    new VStack([secondary, h.dock]),
    undefined,
  ];
  for (const unknown of unknownRoots) {
    h.tui.setLayoutRoot(unknown);
    const slot = new FixedHeaderSlot(header());
    assert.equal(slot.attach(h.tui), "unsupported");
    assert.equal(rootOf(h.tui), unknown);
    slot.dispose();
    assert.equal(rootOf(h.tui), unknown);
  }
});

test("stable renderer proxy reattaches after fullscreen to regular to a new fullscreen host", (t) => {
  const first = host(t);
  const second = host(t);
  const regular = new TuiMainScreen(new FakeTerminal());
  t.after(() => regular.stop());
  let current: TUI = first.tui;
  const proxy = new Proxy({} as TUI, {
    get: (_target, key) => {
      const value = Reflect.get(current, key, current);
      return typeof value === "function" ? value.bind(current) : value;
    },
    has: (_target, key) => Reflect.has(current, key),
  });
  const slot = new FixedHeaderSlot(header());
  t.after(() => slot.dispose());
  assert.equal(slot.attach(proxy), "fixed");
  assertPinned(first.tui);

  // Pi clears the old renderer root before switching its stable proxy target.
  first.tui.setLayoutRoot(undefined);
  first.tui.stop({ preserveScreen: true });
  current = regular;
  assert.equal(slot.sync(), "regular");
  assert.equal(rootOf(first.tui), undefined);

  current = second.tui;
  assert.equal(slot.sync(), "fixed");
  const wrapper = rootOf(second.tui);
  assert.ok(wrapper instanceof VStack);
  assert.equal(wrapper.children[1], second.root);
  assertPinned(second.tui);
  slot.dispose();
  assert.equal(rootOf(second.tui), second.root);
  assert.equal(rootOf(first.tui), undefined);
});
