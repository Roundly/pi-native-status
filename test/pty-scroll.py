#!/usr/bin/env python3
"""Real fullscreen PTY regression for a fixed native status header.

Requires Python 3 and pyte 0.8.x. Runs its own offline mock conversation in an
isolated HOME/agent directory. Assertions inspect decoded terminal screens,
not whether a header appeared somewhere in the output history. Artifacts contain
only this test's mock interaction and the status bar it launches.
"""
import codecs
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time

try:
    import pyte
except ImportError:
    print("Missing pyte. Install requirements-test.txt in your test environment.", file=sys.stderr)
    sys.exit(2)

ROOT = Path(__file__).resolve().parent.parent
FRAME_END = "\x1b[?2026l"
ROW = re.compile(r"SCROLL_ROW_(\d{3})")
PAGE_UP = "\x1b[5~"
PAGE_DOWN = "\x1b[6~"
TOP = "\x1b[1;5H"  # SDK tui.altScreen.top: ctrl+home
BOTTOM = "\x1b[1;5F"  # SDK tui.altScreen.bottom: ctrl+end


def main() -> int:
    node = os.environ.get("PI_NATIVE_STATUS_NODE") or shutil.which("node")
    cli = Path(os.environ.get("PI_NATIVE_STATUS_CLI", str(
        ROOT / "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"
    ))).expanduser().resolve()
    ext_dir = Path(os.environ.get("SMOKE_EXT_DIR", str(ROOT))).resolve()
    if not node or not Path(node).is_file() or not cli.is_file() or not (ext_dir / "index.ts").is_file():
        print("Missing Pi runtime/extension. Run npm ci or set PI_NATIVE_STATUS_NODE, PI_NATIVE_STATUS_CLI and SMOKE_EXT_DIR.", file=sys.stderr)
        return 2

    output_parent = os.environ.get("SMOKE_OUT")
    if output_parent:
        output_parent = str(Path(output_parent).expanduser().resolve())
        Path(output_parent).mkdir(parents=True, exist_ok=True)
    out = Path(tempfile.mkdtemp(prefix="pi-native-status-scroll-", dir=output_parent))
    agent_dir, home_dir, work_dir = (out / name for name in ("agent", "home", "work"))
    for directory in (agent_dir, home_dir, work_dir):
        directory.mkdir()
    (agent_dir / "settings.json").write_text(json.dumps({"quietStartup": True}), encoding="utf-8")
    auto = os.environ.get("SMOKE_AUTO") == "1"
    if auto:
        (agent_dir / "extensions").mkdir()
        (agent_dir / "extensions/native-status").symlink_to(ext_dir)
    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": str(home_dir),
        "PI_CODING_AGENT_DIR": str(agent_dir),
        "PI_OFFLINE": "1",
        "PI_NATIVE_STATUS_SCROLL_TEST": "1",
        "TERM": "xterm-256color",
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "NO_COLOR": "",
    }
    command = [
        node, str(cli), "--offline", *([] if auto else ["--no-extensions"]),
        "--no-session", "--no-context-files", "--no-skills", "--no-prompt-templates",
        "--no-mcp", "--no-tools", "--tui-mode", "fullscreen", "--provider", "mock",
        "--model", "mock-chat", "-e", str(ROOT / "test/mock-provider.ts"),
        *([] if auto else ["-e", str(ext_dir / "index.ts")]),
    ]
    columns, rows = 120, 40
    screen = pyte.Screen(columns, rows)
    stream = pyte.Stream(screen)
    decoder = codecs.getincrementaldecoder("utf-8")("replace")
    raw, pending = "", ""
    frames, steps, violations = [], [], []
    resize_inflight_frames = []
    awaiting_resize_redraw = False
    monitor_pinned = False
    pinned_frames_checked = 0
    complete_frames = 0
    stage = "startup"
    master, slave = pty.openpty()
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
    process = subprocess.Popen(command, cwd=work_dir, stdin=slave, stdout=slave, stderr=slave,
                               env=env, start_new_session=True, close_fds=True)
    os.close(slave)

    def display() -> list[str]:
        return list(screen.display)

    def text() -> str:
        return "\n".join(display())

    def resources(line: str) -> bool:
        return "CPU " in line and "RAM " in line

    def check_pinned(frame: list[str]) -> bool:
        return bool(frame) and resources(frame[0]) and sum(resources(line) for line in frame) == 1

    def record_completed_frame(check_header: bool = True) -> None:
        nonlocal pinned_frames_checked, complete_frames
        complete_frames += 1
        if monitor_pinned and check_header:
            pinned_frames_checked += 1
            frame = display()
            if not check_pinned(frame):
                violations.append({"stage": stage, "row0": frame[0] if frame else "", "frame": pinned_frames_checked})

    def pump(seconds: float) -> None:
        nonlocal raw, pending, awaiting_resize_redraw
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            remaining = max(0.0, end - time.monotonic())
            ready, _, _ = select.select([master], [], [], min(0.1, remaining))
            if not ready:
                if process.poll() is not None:
                    break
                continue
            try:
                chunk = os.read(master, 65536)
            except OSError:
                break
            if not chunk:
                break
            decoded = decoder.decode(chunk)
            raw += decoded
            pending += decoded
            # Assert only complete synchronized frames, never halfway through a
            # TUI redraw merely because an OS read split the escape stream.
            while FRAME_END in pending:
                frame, pending = pending.split(FRAME_END, 1)
                stream.feed(frame + FRAME_END)
                # The terminal can resize while an old-size diff is already in
                # the PTY. Pi fully clears/redraws after a geometry change. Do
                # not decode such in-flight diffs as evidence of a new-layout
                # bug; the first full redraw and every frame after it are still
                # checked, and resize() fails if that redraw never arrives.
                check_header = True
                if awaiting_resize_redraw:
                    if "\x1b[2J" in frame:
                        awaiting_resize_redraw = False
                    else:
                        check_header = False
                        addresses = [int(value) for value in re.findall(r"\x1b\[(\d+);\d+[Hf]", frame)]
                        resize_inflight_frames.append({"stage": stage, "maxAddressedRow": max(addresses, default=0)})
                record_completed_frame(check_header)

    def send(value: str) -> None:
        os.write(master, value.encode("utf-8"))

    def wait_for(label: str, predicate, limit: float = 6.0) -> None:
        end = time.monotonic() + limit
        while time.monotonic() < end:
            if predicate():
                steps.append({"name": label, "passed": True})
                return
            if process.poll() is not None:
                break
            pump(0.15)
        steps.append({"name": label, "passed": False})
        raise AssertionError(label)

    def row_ids(frame: list[str]) -> list[int]:
        return [int(match.group(1)) for line in frame for match in [ROW.search(line)] if match]

    def valid_footer(frame: list[str]) -> bool:
        dock = "\n".join(frame[-6:])
        return all(value in dock for value in ("mock-chat", "tok/s", "TTFT", "上下文"))

    def checkpoint(label: str, pinned: bool = True, footer: bool = True) -> list[str]:
        pump(0.25)
        frame = display()
        frames.append({"name": label, "columns": columns, "rows": rows, "lines": frame})
        (out / f"{label}.txt").write_text("\n".join(frame) + "\n", encoding="utf-8")
        if pinned:
            assert check_pinned(frame), f"{label}: CPU/RAM must appear exactly once, at screen row 0"
        if footer:
            assert valid_footer(frame), f"{label}: footer left its dock"
        ids = row_ids(frame)
        assert all(right == left + 1 for left, right in zip(ids, ids[1:])), f"{label}: body rows are missing/duplicated"
        steps.append({"name": label, "passed": True})
        return frame

    def move(key: str, label: str) -> list[str]:
        nonlocal stage
        stage = label
        previous_frame = complete_frames
        previous_ids = row_ids(display())
        already_at_target = (key == TOP and "SCROLL_FIRST_PROMPT" in text()) or (
            key == BOTTOM and "SCROLL_LAST_LINE" in text()
        )
        def target_reached() -> bool:
            # Repeating Home/End at the target can legitimately produce no
            # terminal diff. Actual page moves must still show a new frame.
            if complete_frames <= previous_frame and not already_at_target:
                return False
            current_ids = row_ids(display())
            if key == TOP:
                return "SCROLL_FIRST_PROMPT" in text()
            if key == BOTTOM:
                return "SCROLL_LAST_LINE" in text()
            if key == PAGE_UP and previous_ids:
                return bool(current_ids) and current_ids[0] < previous_ids[0]
            if key == PAGE_DOWN and previous_ids:
                return bool(current_ids) and current_ids[0] > previous_ids[0]
            return True
        send(key)
        wait_for(f"{label}-new-frame", target_reached)
        return checkpoint(label)

    def editor_probe(label: str) -> None:
        marker = f"INPUT_READY_{label.upper()}"
        send(marker)
        wait_for(f"{label}-input", lambda: marker in "\n".join(display()[-8:]))
        send("\x03")  # SDK app.clear, when the editor contains text.
        wait_for(f"{label}-input-cleared", lambda: marker not in text())

    def resize(new_columns: int, new_rows: int, label: str) -> None:
        nonlocal columns, rows, stage, awaiting_resize_redraw
        pump(0.15)
        stage = label
        previous_frame = complete_frames
        awaiting_resize_redraw = True
        columns, rows = new_columns, new_rows
        screen.resize(lines=rows, columns=columns)
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
        os.kill(process.pid, signal.SIGWINCH)
        wait_for(f"{label}-new-frame", lambda: not awaiting_resize_redraw and complete_frames > previous_frame
                 and check_pinned(display()) and valid_footer(display()))
        checkpoint(label)

    error = None
    try:
        wait_for("startup-pinned-header", lambda: check_pinned(display()) and "mock-chat" in text(), 25)
        checkpoint("startup")
        monitor_pinned = True
        stage = "long-response"
        send("SCROLL_FIRST_PROMPT\r")
        wait_for("long-response-finished", lambda: "SCROLL_LAST_LINE" in text() and bool(re.search(r"\d+(?:\.\d+)?\s+tok/s", text())), 15)
        frame = checkpoint("long-bottom")
        assert "SCROLL_ROW_179" in "\n".join(frame), "last mock row is not reachable"

        middle = move(PAGE_UP, "middle")
        assert ROW.search(middle[1]), "middle: first body row below the header must remain visible"
        assert "SCROLL_ROW_179" not in "\n".join(middle), "PageUp did not scroll the transcript"
        top = move(TOP, "top")
        assert "SCROLL_FIRST_PROMPT" in "\n".join(top), "first prompt was covered or lost"
        assert "SCROLL_FIRST_LINE" in "\n".join(top) and "SCROLL_ROW_000" in "\n".join(top), "first response rows were covered or lost"

        # Walk through overlapping viewport pages and prove every generated row
        # is reachable, including rows near page boundaries and the final row.
        seen = {int(match.group(1)) for line in top for match in [ROW.search(line)] if match}
        for page in range(20):
            current = move(PAGE_DOWN, f"walk-{page:02d}")
            seen.update(int(match.group(1)) for line in current for match in [ROW.search(line)] if match)
            if "SCROLL_LAST_LINE" in "\n".join(current):
                break
        assert seen == set(range(180)), f"mock rows unreachable: {sorted(set(range(180)) - seen)}"
        steps.append({"name": "all-180-body-rows-reachable", "passed": True})
        bottom = move(BOTTOM, "bottom")
        assert "SCROLL_ROW_179" in "\n".join(bottom) and "SCROLL_LAST_LINE" in "\n".join(bottom)
        editor_probe("bottom")
        resize(80, 32, "resize-80")
        move(PAGE_UP, "resize-80-middle")
        resized_top = move(TOP, "resize-80-top")
        assert "SCROLL_FIRST_PROMPT" in "\n".join(resized_top) and "SCROLL_ROW_000" in "\n".join(resized_top)
        move(BOTTOM, "resize-80-bottom")
        resize(120, 40, "resize-120")

        monitor_pinned = False
        stage = "off"
        send("/native-status off\r")
        wait_for("off-restores-default", lambda: not any(resources(line) for line in display()) and "已关闭" in text())
        checkpoint("off", pinned=False, footer=False)
        editor_probe("off")
        stage = "on"
        send("/native-status on\r")
        wait_for("on-restores-pinned-header", lambda: check_pinned(display()) and "已开启" in text())
        checkpoint("on")
        monitor_pinned = True
        move(TOP, "on-top")
        move(BOTTOM, "on-bottom")
        editor_probe("on")

        monitor_pinned = False
        stage = "reload"
        raw_start = len(raw)
        send("/reload\r")
        wait_for("reload-finished", lambda: "Reloaded" in raw[raw_start:] and check_pinned(display()), 15)
        checkpoint("reloaded")
        monitor_pinned = True
        after_reload = move(TOP, "reload-top")
        assert "SCROLL_FIRST_PROMPT" in "\n".join(after_reload) and "SCROLL_ROW_000" in "\n".join(after_reload)
        move(BOTTOM, "reload-bottom")
        editor_probe("reload")
        assert pinned_frames_checked > 10, "too few decoded frames to establish pinned behavior"
        assert not violations, f"header moved or duplicated in {len(violations)} complete frames"
    except (AssertionError, OSError, ValueError) as exc:
        error = str(exc)
        frames.append({"name": "failure", "columns": columns, "rows": rows, "lines": display()})
    finally:
        monitor_pinned = False
        stage = "quit"
        if process.poll() is None:
            try:
                send("\x03")
                send("/quit\r")
            except OSError:
                pass
        # Keep the original eight-second deadline and strict zero exit status.
        # Draining avoids an artificial PTY output-buffer deadlock on macOS.
        quit_deadline = time.monotonic() + 8
        while process.poll() is None and time.monotonic() < quit_deadline:
            pump(min(0.25, max(0.0, quit_deadline - time.monotonic())))
        try:
            process.wait(timeout=0.1)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        pump(0.2)
        if pending:
            stream.feed(pending)
        os.close(master)

    summary = {
        "passed": error is None and process.returncode == 0,
        "exitCode": process.returncode,
        "error": error,
        "steps": steps,
        "pinnedFramesChecked": pinned_frames_checked,
        "completeFrames": complete_frames,
        "headerViolations": violations,
        "resizeInflightFrames": resize_inflight_frames,
        "autoDiscovered": auto,
        "extensionDir": str(ext_dir),
        "artifactDir": str(out),
    }
    (out / "raw.ansi").write_text(raw, encoding="utf-8")
    (out / "frames.json").write_text(json.dumps(frames, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (out / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "passed": summary["passed"], "exitCode": process.returncode, "error": error,
        "stepsPassed": sum(step["passed"] for step in steps),
        "pinnedFramesChecked": pinned_frames_checked, "headerViolations": len(violations),
        "artifactDir": str(out),
    }, ensure_ascii=False))
    return 0 if summary["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
