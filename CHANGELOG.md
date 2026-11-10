# Changelog

## 0.4.1 — 2026-11-10

首个可分发版本。

### 界面

- 原生 Pi TUI 状态栏：1 行 header 显示 CPU、RAM 与主机名，2 行 footer 显示 cwd、分支、模型、thinking 与请求指标。
- 模型标识只出现一次，模型名加粗；实测 TPS 使用灰青色强调；辅助信息使用 muted 颜色。
- 自动跟随 Pi 的深色 / 浅色主题。
- 在 40、60、80、120、160 列宽度下安全截断，路径中间省略，模型与分支尾部省略。
- TUI 启动时采样、之后约每秒采样一次，重绘节流 200 ms；RPC、print、json 模式不启动 UI 或计时器。

### 指标

- CPU：本机全核心差分利用率；首次采样无历史差值时显示 `—`。
- RAM：`total - free`，包含系统缓存。
- TTFT：请求开始到第一个非空 text / thinking / tool-call 片段。
- TPS：`provider usage.output` 除以首片段到 `message_end` 的客户端耗时，表示整段生成的平均速度，不是流式实时速率。
- 缓存：本次请求的 `cacheRead / (input + cacheRead + cacheWrite)`。
- 上下文：使用 Pi 官方上下文用量 API；未知时显示 `—`。
- 新请求、失败或取消会清除旧计时；恢复历史会话时不伪造 TTFT / TPS。
- 没有可靠数据源时不展示额度信息。

### 命令

- `/native-status`：查看用法与指标说明。
- `/native-status on` / `off`：开启或关闭，并恢复 Pi 默认 header/footer。
- `/native-status details`：查看累计 tokens、provider、RAM 总量、TTFT 与速度等次要信息。
- 支持启动参数 `--native-status-off`。

### 工具与分发

- 附带可选的 Ghostty 字体切换工具 `tools/agent-font`，独立运行，不被 Pi 自动加载；使用受管配置块、备份、校验与失败回滚。
- 无运行时第三方依赖，无安装 hooks；SDK 由 Pi 通过 `peerDependencies: "*"` 提供。
- 支持 Pi 1.5.0，已在 macOS 与 Linux 验证；要求 Node.js >= 22.19。
- 测试：44 个单元/渲染测试、11 个字体工具测试、离线隔离 mock provider 的 PTY 冒烟测试。

### 许可证

- MIT © Roundly
- Maple Mono NF CN 为第三方 OFL 字体，不包含在本仓库中。
