#!/usr/bin/env python3
"""PTY smoke test for the native status extension with an offline mock provider.

Spawns its own Pi process in an isolated agent dir, drives keystrokes, and
captures only the mock conversation. It never attaches to the user's terminal
and never reads the user's Pi config or credentials.
"""
import codecs
import fcntl
import os
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

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = os.environ.get("PI_NATIVE_STATUS_NODE") or shutil.which("node") or ""
CLI = os.environ.get("PI_NATIVE_STATUS_CLI") or os.path.join(
    ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"
)
OUT_DIR = ""

ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[@-Z\\-_]")


def strip(data: str) -> str:
    return ANSI.sub("", data)


def main() -> int:
    global OUT_DIR
    if not os.path.isfile(NODE) or not os.path.isfile(CLI):
        print("Missing Pi runtime. Run npm ci, or set PI_NATIVE_STATUS_NODE and PI_NATIVE_STATUS_CLI.", file=sys.stderr)
        return 2
    output_parent = os.environ.get("SMOKE_OUT")
    if output_parent:
        output_parent = os.path.abspath(os.path.expanduser(output_parent))
        os.makedirs(output_parent, exist_ok=True)
    OUT_DIR = tempfile.mkdtemp(prefix="pi-native-status-smoke-", dir=output_parent)
    agent_dir = os.path.join(OUT_DIR, "agent")
    home_dir = os.path.join(OUT_DIR, "home")
    work_dir = os.path.join(OUT_DIR, "work")
    for path in (agent_dir, home_dir, work_dir):
        os.makedirs(path, exist_ok=True)
    os.makedirs(os.path.join(agent_dir, "extensions"), exist_ok=True)

    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": home_dir,
        "PI_CODING_AGENT_DIR": agent_dir,
        "PI_OFFLINE": "1",
        "TERM": "xterm-256color",
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "NO_COLOR": "",
    }
    auto_discovered = os.environ.get("SMOKE_AUTO") == "1"
    ext_dir = os.path.abspath(os.environ.get("SMOKE_EXT_DIR", ROOT))
    if auto_discovered:
        os.symlink(ext_dir, os.path.join(agent_dir, "extensions", "native-status"))
    cmd = [
        NODE,
        CLI,
        "--offline",
        *( [] if auto_discovered else ["--no-extensions"] ),
        "--no-session",
        "--no-context-files",
        "--no-skills",
        "--no-prompt-templates",
        "--no-mcp",
        "--no-tools",
        "--tui-mode",
        "regular",
        "--provider",
        "mock",
        "--model",
        "mock-chat",
        "-e",
        os.path.join(ROOT, "test", "mock-provider.ts"),
        *( [] if auto_discovered else ["-e", os.path.join(ROOT, "index.ts")] ),
    ]

    master, slave = pty.openpty()
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    process = subprocess.Popen(
        cmd,
        cwd=work_dir,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        env=env,
        start_new_session=True,
        close_fds=True,
    )
    os.close(slave)
    raw = ""
    decoder = codecs.getincrementaldecoder("utf-8")("replace")
    steps = []
    deadline = time.time() + 45

    def pump(seconds: float) -> None:
        nonlocal raw
        end = time.time() + seconds
        while time.time() < end:
            ready, _, _ = select.select([master], [], [], min(0.2, max(0.0, end - time.time())))
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
            raw += decoder.decode(chunk)

    def wait_for(label: str, needle: str, limit: float) -> bool:
        nonlocal raw
        end = time.time() + limit
        while time.time() < end:
            if needle in raw or needle in strip(raw):
                steps.append((label, True))
                return True
            pump(0.25)
        steps.append((label, False))
        return False

    def wait_for_regex(label: str, pattern: str, limit: float) -> bool:
        nonlocal raw
        end = time.time() + limit
        regex = re.compile(pattern)
        while time.time() < end:
            if regex.search(raw) or regex.search(strip(raw)):
                steps.append((label, True))
                return True
            pump(0.25)
        steps.append((label, False))
        return False

    def send(text: str) -> None:
        os.write(master, text.encode())

    ok = True
    ok &= wait_for("header", "CPU ", 25)
    ok &= wait_for("model", "mock-chat", 5)
    pump(1.0)
    ok &= wait_for("footer", "缓存", 5)
    ok &= wait_for("metric-labels", "tok/s", 5)
    send("hello\r")
    ok &= wait_for_regex("mock-complete", r"\d+(?:\.\d+)?\s+tok/s", 15)
    ok &= wait_for("timing", "TTFT ", 5)
    pump(0.4)
    with open(os.path.join(OUT_DIR, "ready.ansi"), "w", encoding="utf-8") as handle:
        handle.write(raw)
    send("/native-status details\r")
    ok &= wait_for("details", "native-status 详情", 5)
    ok &= wait_for("details-provider", "Provider:", 5)
    send("/native-status off\r")
    ok &= wait_for("off-notice", "已关闭", 5)
    send("/native-status on\r")
    ok &= wait_for("on-notice", "已开启", 5)
    send("/native-status\r")
    ok &= wait_for("help", "cacheRead", 5)
    send("/quit\r")
    try:
        process.wait(timeout=8)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)
    pump(1.0)
    os.close(master)

    cleaned = strip(raw)
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(os.path.join(OUT_DIR, "raw.log"), "w", encoding="utf-8") as handle:
        handle.write(raw)
    with open(os.path.join(OUT_DIR, "clean.log"), "w", encoding="utf-8") as handle:
        handle.write(cleaned)
    summary = {
        "exitCode": process.returncode,
        "steps": steps,
        "characters": len(cleaned),
        "hasHeader": "Model:" not in cleaned and "CPU " in cleaned and "mock-chat" in cleaned,
        "hasFooter": "缓存" in cleaned and "tok/s" in cleaned and "TTFT" in cleaned,
        "hasTtft": "TTFT" in cleaned,
        "hasThroughput": "tok/s" in cleaned,
        "hasCachePercent": bool(re.search(r"缓存\s+(?:\d+(?:\.\d+)?%|<1%)", cleaned)),
        "hasNumericTtft": bool(re.search(r"TTFT\s+\d+(?:\.\d+)?s", cleaned)),
        "hasNumericThroughput": bool(re.search(r"\d+(?:\.\d+)?\s+tok/s", cleaned)),
        "agentDir": agent_dir,
        "autoDiscovered": auto_discovered,
    }
    print(summary)
    return 0 if ok and process.returncode == 0 and summary["hasNumericTtft"] and summary["hasNumericThroughput"] else 1


if __name__ == "__main__":
    sys.exit(main())
