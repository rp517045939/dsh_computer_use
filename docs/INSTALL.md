# 安装与分发

插件包本身只有十几 KB：**运行环境在目标机上按需生成，不随包分发**。只有无外网的机器才追加 payload。

## 前提

| 项 | 要求 | 说明 |
|---|---|---|
| 系统 | Windows 10/11 x64 | 引擎依赖 UIAutomation |
| Python | 3.14 及以上 | 系统未装也能用：payload 运行时或 `init.mode: auto` |
| 网络 | 首次配置需要 PyPI | 装了 payload 则可离线 |
| DSH | 桌面版 / Web 版均可 | 需要 `mcpManager` 服务（桌面 profile 默认有） |

Python 3.14 缺失时先装：

```powershell
winget install Python.Python.3.14
```

## 在线安装（默认）

1. 把仓库根目录（或 `dist/dsh-windows-mcp/`）拷到目标机；也可以直接从 GitHub 装，见 README。
2. DSH → **Plugins** → **Add plugin** → 选这个目录。
3. 新开一个会话，让模型执行一次 `windows_mcp_setup`；或者把配置里 `init.mode` 改成 `setup`，激活时自动建环境。

首次配置约 2–3 分钟（建 venv + 装约 90 个 wheel + 210 MB 磁盘）。

## 离线安装（无外网机器）

在一台**有网**的机器上准备 payload，再整体拷贝：

```
<仓库根或 dist 包>/
└─ payload/
   ├─ python/          # 便携 CPython 3.14（需自行放置：python/python.exe 可执行即可）
   └─ wheelhouse/      # 依赖 wheel；在有网机器上：
                       #   pip download windows-mcp==0.9.0 -d payload/wheelhouse
                       #   以及 venv 里的 pip download --no-deps 补齐传递依赖
```

放置后：

```powershell
node scripts/pack.mjs --zip     # 产出 dist/dsh-windows-mcp.zip
```

安装了 payload 时，`windows_mcp_setup` 会用 `--no-index --find-links payload/wheelhouse` 从本地装，不访问 PyPI；`payload/python/python.exe` 会作为解释器候选，优先于系统 Python。

## 配置速查

| 字段 | 默认 | 作用 |
|---|---|---|
| `serverName` | `windows` | 工具命名空间；工具名 `mcp__<serverName>__<tool>` |
| `init.mode` | `advise` | 激活时是否自动建环境：`detect`/`advise`/`setup`/`auto` |
| `engine.dir` | `$DSH_HOME/windows-mcp` | venv 与状态文件位置 |
| `engineVersion` | `0.9.0` | 首次安装的版本；之后跟 release 通道 |
| `update.auto` | `true` | 是否自动装新版本（带回滚） |
| `update.applyOnStart` | `true` | 激活 30 秒后自动检查一次 |
| `update.debounceHours` | `24` | 自动升级最短间隔 |
| `update.maxAttempts` | `2` | 同一版本失败几次后停手 |
| `tools.exclude` | PowerShell / Registry / FileSystem / Process | 从引擎工具面里剔除的工具名 |

## 更新行为

- 只跟 **PyPI 上的正式 release**，不跟 `main`、不跟 prerelease。
- 每次升级前：查 wheel 摘要 → 装新版本 → **先握手探针** → **工具面漂移校验** → 才切换实例。
- 任一步失败：装回上一版本、重启实例、在状态里写明失败原因；同一版本失败 2 次后不再自动重试。
- 状态里能看到：当前版本、上游最新版本、上次升级结果、工具面工具数。

## 故障排查

先跑 `windows_mcp_status`，按输出逐项看：

| 现象 | 含义 | 处理 |
|---|---|---|
| `python MISSING` | 没有 3.14 | `winget install Python.Python.3.14`，再 `windows_mcp_setup` |
| `pip MISSING` | 解释器没有 pip | `python -m ensurepip --upgrade` |
| `engine none` | 还没建环境 | `windows_mcp_setup`，或 `init.mode: setup` |
| `not registered` + `register() refused` | 名字被静态 MCP 行占用 | 见 MIGRATION.md，或先换 `serverName` |
| `release (unavailable)` | 连不上 PyPI | 配代理；离线机器用 payload |
| `update ... failed:policy` | 新版本工具面破线（被剔工具改名/消失） | 已自动回滚；确认上游改名后调整 `tools.exclude` |

日志：`<engine.dir>/state.json` 记录最近状态；插件日志走 DSH 的 Host 日志输出，前缀 `[windows-mcp]`。
