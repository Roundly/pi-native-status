#!/usr/bin/env python3
"""Isolated tests for agent-font: fake Ghostty CLI + temp dirs only."""
import os
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "agent-font"

FAKE_CLI = r'''#!/usr/bin/env python3
import os, sys
args = sys.argv[1:]
def note():
    sys.stderr.write("error: SentryInitFailed\n")
if args == ["+list-fonts"]:
    sys.stdout.write("""Maple Mono NF CN
  Maple Mono NF CN Regular
  Maple Mono NF CN Bold
  Maple Mono NF CN Italic
  Maple Mono NF CN Bold Italic
Menlo
  Menlo Regular
Monaco
  Monaco Regular
JetBrains Mono
  JetBrains Mono Regular
Space Grotesk
  Space Grotesk Regular
Broken Font
  Broken Font Regular
""")
    note()
    sys.exit(0)
if args[:1] == ["+validate-config"]:
    path = None
    for arg in args[1:]:
        if arg.startswith("--config-file="):
            path = arg.split("=", 1)[1]
    data = open(path, encoding="utf-8").read() if path else ""
    note()
    if "Broken Font" in data or os.environ.get("FAKE_VALIDATE_FAIL") == "1":
        sys.stderr.write("error: bad font-family for test\n")
        sys.exit(1)
    sys.exit(0)
sys.stderr.write("error: unsupported fake args: %r\n" % (args,))
sys.exit(2)
'''

ORIGINAL = (
    "font-size = 14\n"
    "theme = Catppuccin Mocha\n"
    "font-family = Menlo\n"
    "font-family-bold = Menlo Bold\n"
    "# keep this comment\n"
)
BEGIN = "# >>> agent-font managed block >>>"
END = "# <<< agent-font managed block <<<"


class AgentFontTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.ghostty = self.base / "ghostty"
        self.ghostty.write_text(FAKE_CLI, encoding="utf-8")
        self.ghostty.chmod(0o755)
        self.config = self.base / "config.ghostty"
        self.config.write_text(ORIGINAL, encoding="utf-8")
        self.config.chmod(0o640)
        self.backups = self.base / "backups"

    def run_cli(self, *args, ghostty=None, use_backup=True, home=None):
        cmd = [sys.executable, str(SCRIPT), "--config", str(self.config),
               "--ghostty", str(ghostty or self.ghostty), *args]
        if use_backup:
            cmd[4:4] = ["--backup-dir", str(self.backups)]
        env = os.environ.copy()
        if home is not None:
            env["HOME"] = str(home)
            env["XDG_STATE_HOME"] = str(home / ".local/state")
        return subprocess.run(cmd, capture_output=True, text=True, timeout=20, env=env)

    def text(self):
        return self.config.read_text(encoding="utf-8")

    def backup_dirs(self):
        return sorted(p for p in self.backups.glob("*") if p.is_dir()) if self.backups.exists() else []

    def test_not_installed_does_not_modify(self):
        proc = self.run_cli("set", "Not Installed Font")
        self.assertNotEqual(proc.returncode, 0)
        self.assertEqual(self.text(), ORIGINAL)
        self.assertEqual(self.backup_dirs(), [])

    def test_switch_only_managed_block(self):
        proc = self.run_cli("set", "Maple Mono NF CN")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        text = self.text()
        self.assertTrue(text.startswith(ORIGINAL))
        self.assertIn(BEGIN, text)
        self.assertIn(END, text)
        self.assertIn('font-family = ""\nfont-family = "Maple Mono NF CN"', text)
        self.assertIn('font-family-bold = ""', text)
        self.assertEqual(os.stat(self.config).st_mode & 0o777, 0o640)
        backups = self.backup_dirs()
        self.assertEqual(len(backups), 1)
        self.assertEqual((backups[0] / self.config.name).read_text(encoding="utf-8"), ORIGINAL)
        self.assertIn("⌘⇧,", proc.stdout)

    def test_default_removes_only_managed_block(self):
        self.assertEqual(self.run_cli("set", "Maple Mono NF CN").returncode, 0)
        proc = self.run_cli("default")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(self.text(), ORIGINAL)
        self.assertEqual(len(self.backup_dirs()), 2)

    def test_validation_failure_rolls_back_and_filters_sentry(self):
        proc = self.run_cli("set", "Broken Font")
        self.assertNotEqual(proc.returncode, 0)
        self.assertEqual(self.text(), ORIGINAL)
        self.assertIn("bad font-family for test", proc.stderr)
        self.assertNotIn("SentryInitFailed", proc.stderr)
        self.assertEqual(len(self.backup_dirs()), 1)

    def test_space_name_valid_and_control_chars_invalid(self):
        proc = self.run_cli("set", "JetBrains Mono")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        good = self.text()
        for bad in ("Maple\nMono", "Maple\rMono", "Maple\x1bMono",
                    "Maple\x7fMono", "Maple\x80Mono", "Maple\x9fMono"):
            proc = self.run_cli("set", bad)
            self.assertNotEqual(proc.returncode, 0)
            self.assertIn("控制符", proc.stderr)
            self.assertEqual(self.text(), good)

    def test_list_common_and_all(self):
        proc = self.run_cli("list")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        lines = [line for line in proc.stdout.splitlines() if line]
        self.assertEqual(lines, ["Maple Mono NF CN", "Menlo", "Monaco", "JetBrains Mono"])
        proc = self.run_cli("list", "--all")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("Space Grotesk", proc.stdout.splitlines())

    def test_missing_ghostty_is_clear_and_no_change(self):
        proc = self.run_cli("maple", ghostty=self.base / "missing-ghostty")
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("字体由显示终端负责，SSH远端不能替Mac换字体", proc.stderr)
        self.assertEqual(self.text(), ORIGINAL)
        self.assertEqual(self.backup_dirs(), [])

    def test_config_file_nesting_refused(self):
        self.config.write_text("config-file = other.conf\n" + ORIGINAL, encoding="utf-8")
        before = self.text()
        proc = self.run_cli("maple")
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("config-file", proc.stderr)
        self.assertEqual(self.text(), before)

    def test_default_backup_root_without_flag(self):
        home = self.base / "home"
        home.mkdir()
        proc = self.run_cli("maple", use_backup=False, home=home)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        backup_root = (home / "Library/Application Support/agent-font/backups"
                       if sys.platform == "darwin" else home / ".local/state/agent-font/backups")
        backups = list(backup_root.glob("*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual((backups[0] / self.config.name).read_text(encoding="utf-8"), ORIGINAL)

    def test_mac_default_sources_include_xdg_and_refuse_multiple(self):
        module = types.ModuleType("agent_font_module")
        exec(compile(SCRIPT.read_text(encoding="utf-8"), str(SCRIPT), "exec"), module.__dict__)
        home = self.base / "mac-home"
        xdg = self.base / "xdg"
        lib = home / "Library/Application Support/com.mitchellh.ghostty"
        lib.mkdir(parents=True)
        xdg_config = xdg / "ghostty"
        xdg_config.mkdir(parents=True)
        (lib / "config.ghostty").write_text("font-size = 14\n", encoding="utf-8")
        (xdg_config / "helper.sh").write_text("#!/bin/sh\n", encoding="utf-8")
        old = (module.sys.platform, os.environ.get("HOME"), os.environ.get("XDG_CONFIG_HOME"))
        module.sys.platform = "darwin"
        os.environ["HOME"] = str(home)
        os.environ["XDG_CONFIG_HOME"] = str(xdg)
        try:
            self.assertEqual(module.config_path(None), lib / "config.ghostty")
            (xdg_config / "config").write_text("font-size = 13\n", encoding="utf-8")
            with self.assertRaises(module.ToolError):
                module.config_path(None)
        finally:
            module.sys.platform, home_env, xdg_env = old
            if home_env is None:
                os.environ.pop("HOME", None)
            else:
                os.environ["HOME"] = home_env
            if xdg_env is None:
                os.environ.pop("XDG_CONFIG_HOME", None)
            else:
                os.environ["XDG_CONFIG_HOME"] = xdg_env

    def test_non_tty_default_is_help_and_current(self):
        proc = self.run_cli()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("用法:", proc.stdout)
        self.assertIn("当前字体：Menlo", proc.stdout)


if __name__ == "__main__":
    unittest.main()
