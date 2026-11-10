import { isViewportTUI, ScrollView, VStack, type Component, type TUI } from "@earendil-works/pi-tui";

export type HeaderPlacement = "fixed" | "regular" | "unsupported" | "detached";

/**
 * Pi 1.5 exposes setLayoutRoot but no getter. Keep its one read-only internal
 * dependency here, and validate the host's transcript/dock structure before use.
 * All layout changes use the public viewport API; host children stay untouched.
 */
function currentRoot(tui: TUI): Component | undefined {
  const root = (tui as TUI & { layoutRoot?: Component }).layoutRoot;
  return root && typeof root.render === "function" ? root : undefined;
}

function isChatViewport(root: Component): boolean {
  return root instanceof VStack && root.children.length === 2 &&
    root.children[0] instanceof ScrollView && root.children[0].primary &&
    root.children[1] instanceof VStack;
}

export class FixedHeaderSlot {
  private tui: TUI | null = null;
  private original: Component | undefined;
  private wrapper: Component | undefined;
  private placement: HeaderPlacement = "detached";
  private readonly header: Component;

  constructor(header: Component) { this.header = header; }

  get state(): HeaderPlacement { return this.placement; }

  attach(tui: TUI): HeaderPlacement {
    this.dispose();
    this.tui = tui;
    return this.sync();
  }

  /** Reconcile Pi's live renderer proxy after a fullscreen/regular switch. */
  sync(): HeaderPlacement {
    const tui = this.tui;
    if (!tui) return this.placement = "detached";
    try {
      if (tui.mode !== "fullscreen" || !isViewportTUI(tui)) {
        this.original = undefined;
        this.wrapper = undefined;
        return this.placement = "regular";
      }
      const root = currentRoot(tui);
      if (root && root === this.wrapper) return this.placement = "fixed";
      // The host may have remounted its own viewport on a new renderer. Never
      // replace an unfamiliar root installed by some other extension.
      this.original = undefined;
      this.wrapper = undefined;
      if (!root || !isChatViewport(root)) return this.placement = "unsupported";
      const wrapper = new VStack([
        { component: this.header, basis: 1, grow: 0, shrink: 0, minSize: 1, maxSize: 1 },
        { component: root, basis: 0, grow: 1, shrink: 1, minSize: 1 },
      ]);
      this.original = root;
      this.wrapper = wrapper;
      tui.setLayoutRoot(wrapper);
      return this.placement = "fixed";
    } catch {
      return this.placement = "unsupported";
    }
  }

  describe(): string {
    switch (this.placement) {
      case "fixed": return "全屏固定顶部";
      case "regular": return "普通 header（regular 模式；固定顶部需要 fullscreen）";
      case "unsupported": return "普通 header（无法识别宿主全屏布局）";
      default: return "未挂载";
    }
  }

  dispose(): void {
    const tui = this.tui;
    try {
      if (tui && this.wrapper && this.original && isViewportTUI(tui) && currentRoot(tui) === this.wrapper) {
        tui.setLayoutRoot(this.original);
      }
    } catch {
      // A stopped/replaced host owns its current layout. Do not overwrite it.
    }
    this.original = undefined;
    this.wrapper = undefined;
    this.tui = null;
    this.placement = "detached";
  }
}
