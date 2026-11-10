# 字体与 Ghostty 工具（可选）

状态栏不捆绑也不安装任何字体。推荐使用 **Maple Mono NF CN**：它来自官方仓库 [subframe7536/maple-font](https://github.com/subframe7536/maple-font)，采用 OFL 许可证。请从该仓库的 Releases 或文档说明自行安装；本仓库不附带字体二进制文件。

字体由**显示终端**负责。通过 SSH 使用 Pi 时，字体需要在本地客户端设置，远端运行的 `agent-font` 无法替本机换字体。

## agent-font

`tools/agent-font` 是一个零依赖的 Python 3 小工具，只维护 Ghostty 配置中一段带起止 marker 的 `font-family` 管理块，不改字号、主题、快捷键或网络设置。它是独立脚本，不会被 Pi 自动加载。

### 运行方式

可以直接用 Python 运行，无需安装：

```bash
python3 tools/agent-font
python3 tools/agent-font list
python3 tools/agent-font maple
python3 tools/agent-font set "JetBrains Mono"
python3 tools/agent-font default
```

在 macOS 上也可以放到 `PATH` 中的目录：

```bash
mkdir -p "$HOME/.local/bin"
install -m755 tools/agent-font "$HOME/.local/bin/agent-font"
```

如果 `$HOME/.local/bin` 不在 `PATH` 中，需要自行把该目录加入 shell 配置。

### 命令

```text
agent-font                     # TTY：已安装常用等宽字体编号菜单；非 TTY：帮助 + 当前配置
agent-font list                # 实际存在的常用等宽字体
agent-font list --all          # 所有真实 family
agent-font maple               # 切换到 Maple Mono NF CN
agent-font set "Family Name"   # 切换到已安装的指定 family
agent-font default             # 删除管理块，恢复原字体（restore 同义）
```

### 默认路径

macOS 默认读取：

```text
~/Library/Application Support/com.mitchellh.ghostty/config.ghostty
```

同时也会检查 `~/.config/ghostty/config`（或 `$XDG_CONFIG_HOME/ghostty/config`）。如果多个默认来源同时存在，工具会拒绝猜测并要求显式指定配置。

默认 Ghostty CLI：

```text
/Applications/Ghostty.app/Contents/MacOS/ghostty
```

可用选项覆盖默认值：

```text
--config PATH       指定 Ghostty 配置文件
--ghostty PATH      指定 Ghostty CLI
--backup-dir PATH   指定备份根目录
```

### 行为

- 切换前通过 Ghostty 的 `+list-fonts` 确认 family 真实存在；名称含控制字符或换行时直接拒绝。
- 只追加或更新带 marker 的管理块。块内先重置 `font-family`，再写入目标 family；如果原配置单独设置了 bold / italic family，也会在管理块内清空，让样式跟随目标字体。
- 修改前自动备份，可用 `--backup-dir` 指定备份位置。
- 原子写入后调用 `ghostty +validate-config` 校验；校验失败会自动回滚，并保留原配置备份。
- 发现多个默认配置来源、`config-file` 嵌套，或管理块之后仍有 `font-family` 时，拒绝猜测和修改。
- 未找到 Ghostty 时提示字体由显示终端负责，不写任何文件。

切换成功后，在 macOS 的 Ghostty 中按 `⌘⇧,` 刷新配置（Ghostty 默认的 `reload_config`）。这不是 Pi 的 `/reload`。

## 测试

测试全部使用 fake CLI 与临时目录，不读取真实用户配置、不联网、不读凭据：

```bash
python3 -m unittest discover -s tools/tests -v
```

或在仓库根目录运行：

```bash
npm run test:fonts
```
