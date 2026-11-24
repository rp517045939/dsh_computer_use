# Windows 桌面操作（dsh-windows-mcp）

把「看见屏幕、点鼠标、敲键盘」做成**一个插件**，而不是一条需要手工维护的 MCP 配置。

插件自己负责引擎的一生：探测本机 Python、在私有目录建虚拟环境、装上游
[Windows-MCP](https://github.com/CursorTouch/Windows-MCP)，注册给 DSH 的 MCP 管理器，
然后跟着 release 通道自己升级——升坏了自己回滚。引擎是内部实现，用户只看到一个 Plugins 条目。

## 它能做什么

| 阶段 | 行为 |
|---|---|
| 探测 | `py -3.14` → payload 运行时 → `PATH` → 常见安装路径，逐个验 `>= 3.14`，跳过 Microsoft Store 别名 |
| 供给 | `-m venv <engine.dir>\venv`，再 `pip install windows-mcp==<version>`；有 payload 时走 `--no-index --find-links` 离线安装 |
| 注册 | `ctx.mcpManager.register(serverName, …)`，工具以 `mcp__<serverName>__<tool>` 出现 |
| 更新 | 只跟 PyPI 正式 release；装前验 wheel 摘要、握手探针、工具面漂移校验；失败自动回滚 |
| 报告 | `windows_mcp_status`：解释器、引擎、注册、上游最新版本、上次升级结果 |

## 初始化模式

默认 `advise`：**只报告，不下载、不安装**。

| 模式 | 激活时 |
|---|---|
| `detect` | 只探测 |
| `advise`（默认） | 探测 + 给出可复制的修复命令 |
| `setup` | 直接建 venv 并装引擎 |
| `auto` | 同上，并允许在缺 Python 3.14 时下载便携运行时 |

## 三个工具

- **`windows_mcp_status`** — 解释器、引擎模式/版本/路径、注册状态、上游最新 release、上次升级。`refresh: true` 重新探测并联网查 PyPI。
- **`windows_mcp_setup`** — 建 venv、装引擎、注册。`force: true` 可重装。
- **`windows_mcp_update`** — `action: check / apply / rollback`，`apply` 可带 `version`。

## 升级怎么算过

1. 查 PyPI，确认目标版本存在且没被 yank；
2. 装进同一个 venv（**路径固定**，所以重启实例就加载新代码，不需要改配置）；
3. 新引擎必须能完成 MCP 握手；
4. 工具面双探针比对：带 `--exclude-tools` 和不带各跑一次——
   被剔除的工具若在上游改名/消失，或剔除后什么都没减少，判为漂移，**拒绝上线**；
5. 全过才切实例；任一步失败 → 装回上一版 + 重启 + 记录原因；同一版本失败两次不再自动重试。

## 已知限制

- **`engine.attachVenv` 只是迁移加速**：用它插件就不自包含，换机器会失效，状态页会明示。
- **命名空间唯一**：`serverName` 不能与其它 MCP 实例重名。已有手工 `serverName: windows` 的机器必须先停那一行（见 MIGRATION.md）。
- **升级有短暂空窗**：实例重启时桌面工具会消失几秒，正在进行的调用可能失败一次。
- **首次供给要网络**：约 90 个 wheel、约 210 MB；离线机器需要 payload。
- **Python 3.14 是硬门槛**：DSH 自带运行时是 3.12，低于上游要求。

## 典型配置

```yaml
- id: windows-mcp
  name: "dsh-windows-mcp"
  config:
    serverName: windows
    init:
      mode: advise          # 想让它自己装就改成 setup
    engineVersion: "0.9.0"
    update:
      auto: true            # 自动升级（带自动回滚）
    tools:
      exclude: [PowerShell, Registry, FileSystem, Process]
```
