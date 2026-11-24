# Windows-MCP 自包含插件 · 设计决议（v2）

> 状态：设计定稿中（三条批注已裁决）。实现未开始。
> 上一版假设「插件托管一个本机既有 MCP」；本版推翻了这一点：**插件自己供给引擎，可独立分发。**

## 1 背景与范围

### 1.1 目标

一个单包可分发的 DSH 插件，在任意一台 Windows 机器上装完即用，且：

1. **不依赖任何既有 MCP 安装**（不引用 `D:\mcp\Windows_MCP`，不引用 opencode/cursor 的配置）。
2. **不依赖目标机已装 Python**：运行时由插件自备。
3. **能跟上游更新**：只跟 release，装新版自动生效，坏了自己回滚。
4. **可下线旧的挂载 MCP**：插件上线后，旧条目与旧目录都可以删。

### 1.2 非目标（明确不做）

| 不做 | 原因 |
|---|---|
| 用 TS 重写 UIA 工具 | 等于 fork 上游，从此每条 bugfix 都要人工移植，与「跟更新」直接冲突 |
| 适配 `dsh-computer-use` provider seam | 本安装未分发 `dsh-experimental-computer-use-cua-driver-mcp`，无范本；seam 语义是应用/窗口对象+授权，UIA 工具硬塞成本高于收益 |
| 依赖 GitHub REST API 做更新检测 | 本机实测 **403 限流**（未认证 60/h 按 IP 共享），不可靠 |

### 1.3 验收标准（硬指标）

- 断网 + 重启 DSH，`mcp__windows__*` 全部可用。
- 删除 `D:\mcp\Windows_MCP` 与 opencode 里的 mcp 配置后，功能无任何变化。
- 在一台**没装过 windows-mcp、也没装 Python** 的机器上装插件：状态页列出缺哪几项 + 可复制的修复命令，用户装好 Python 3.14 后点一次「初始化」即可用；只有 `auto` 模式才是一键装成（需要下载运行时）。

## 2 架构骨架

### 2.1 分层

| 层 | 承载 | 是否随包分发 |
|---|---|---|
| 插件包 | 代码、patch、locale、图标、详情页、可选 payload | 是 |
| 数据目录 | venv、可选运行时、状态、日志、wheel 缓存 | 否（按需初始化，默认不预置） |
| 引擎 | 上游 `windows-mcp`（Python，MIT） | 否（默认 PyPI 拉取；离线才走 payload） |
| 注册 | `ctx.mcpManager.register('windows', …)` | 否（运行时行为） |

引擎是插件的**内部实现细节**：用户看不到「又配了一个 MCP」，只看到 Plugins 里的一个条目。

### 2.2 关键约束：工具名不变

注册时 `serverName` 固定为 `windows`，因此工具名保持 `mcp__windows__Snapshot` 等原样，现有提示词、技能、肌肉记忆零迁移成本。代价是**不能与旧的静态行共存**（同名冲突会被 manager 拒绝），旧行必须在安装前下线——见 §6。

### 2.3 目录布局

```
插件包（≈200 KB，不含 payload）
├─ package.json / cordis.patch.yml
├─ index.js                  Host 入口：apply(ctx, config)
├─ lib/{provision,env,upstream,install,policy,state,tools}.js
├─ locale/{en,zh}.json       Plugins 里的标题/描述
├─ docs/DETAIL.md            详情页
├─ icon.svg
└─ payload/                  可选：离线运行时 + wheelhouse

$DSH_HOME\windows-mcp\       跨插件重装保留
├─ runtime\                  **可选**：仅 auto 模式或离线 payload 才有；默认用系统 Python
├─ venv\                     由探测到的 Python 3.14 创建；**路径固定**，是「重启即加载新代码」的前提
├─ state.json                体检结果/版本/通道/上次检查/回滚点
├─ cache\wheelhouse\         whl 缓存，供离线与回滚
└─ logs\                     provision / pip / 启动日志
```

## 3 更新链路（决议 1：只跟 release）

### 3.1 通道定义

只有一个通道：**PyPI 上的正式发布版本**。`main` 分支、任意 commit、prerelease 一律不跟。

理由：需要跟的是「上游发布给用户的版本」，而 PyPI 的 `info.version` 恰好就是 `pip install` 会装到的东西——它和引擎来源天然一致，不会出现「检查到 0.9.0 但装不上」的错位。

### 3.2 信号源

| 用途 | 源 | 本机实测 |
|---|---|---|
| 权威版本号 | `https://pypi.org/pypi/windows-mcp/json` → `info.version` | 通（返回 0.9.0） |
| 交叉验证 + 发布说明 | `https://github.com/CursorTouch/Windows-MCP/releases.atom` | 通（拿到 v0.9.0/11-22 等） |
| 兜底（包被 yank 时判断） | PyPI JSON 的 `releases[ver][].yanked` | 通 |
| ~~GitHub REST API~~ | `api.github.com/repos/...` | **403 已限流，弃用** |

`releases.atom` 只用于「确认该 tag 真实存在」和「把发布说明摘要写进状态/详情页」，不参与版本决策。

### 3.3 版本比较

自写 semver 比较（上游是 `0.x.y`，形态稳定：`major.minor.patch`，无 build 元数据）。不引入 `semver` 依赖，避免插件包多一个运行时依赖。

判定规则：

- `latest > installed` → 可升级。
- `latest == installed` → 无事。
- `latest < installed` → 视为上游回撤（如 yank），**不自动降级**，只报警。

### 3.4 检查时机

| 触发 | 时机 | 说明 |
|---|---|---|
| 启动检查 | Host 就绪后延迟 30 s，且距 `lastCheckAt` > 24 h 才真查 | 延迟避开启动高峰；TTL 避免频繁重启时反复打 PyPI |
| 定期检查 | 每 24 h | 定时器挂在插件 fiber 上，卸载即清 |
| 手动检查 | 模型工具 `windows_mcp_update` 的 `check` 动作 | 不受 TTL 限制 |

检查本身**无副作用**：只写 `state.json.lastCheckAt / latestKnown`，不动 venv。

### 3.5 状态记录

`state.json` 中与更新相关的字段：

```json
{
  "channel": "release",
  "installed": "0.8.8",
  "latestKnown": "0.9.0",
  "lastCheckAt": "2026-11-24T09:40:00Z",
  "lastUpgrade": { "from": "0.8.8", "to": "0.9.0", "at": "…", "result": "ok|rolled-back" },
  "prev": "0.8.8",
  "attempts": [{ "version": "0.9.0", "at": "…", "result": "failed:policy-drift" }]
}
```

## 4 自动安装与回滚（决议 2：允许自动装，坏了自己回滚）

### 4.1 自动装的前置闸门

七条全满足才动手，任一不满足就只更新 `latestKnown` 并停手：

1. 通道为 `release`。
2. 目标版本在 PyPI `releases` 中存在、`yanked == false`、非 prerelease。
3. 引擎已初始化且健康（venv 存在、`windows-mcp.exe` 可执行）；未初始化时只报体检结果，不触发升级。
4. 磁盘剩余 ≥ 1.5 GB（要留出旧版本 whl 的空间）。
5. 该目标版本的历史失败次数 < 2（防同一坏版本反复重试）。
6. 距上次自动升级 ≥ 24 h（防版本抖动时连环升级）。
7. 当前无并发升级（`state.json` 加锁文件 `.upgrading`）。

### 4.2 升级步骤（每步带超时，失败即跳 4.3）

| # | 动作 | 超时 | 失败含义 |
|---|---|---|---|
| 1 | `pip download` 预取目标 whl 到 `cache\wheelhouse` | 300 s | 网络/源不可达 |
| 2 | `venv\Scripts\python.exe -m pip install --no-input windows-mcp==X` | 300 s | 依赖解析失败、wheel 不兼容 |
| 3 | `venv\Scripts\windows-mcp.exe --help` 冒烟 | 30 s | 包能装但跑不起来（ABI/COM 问题） |
| 4 | `mcpManager.restart('windows')` | 30 s | 实例换不起来 |
| 5 | 等实例 ready（`list()` 状态 + `probe()`） | 60 s | 新版本握手失败 |
| 6 | 工具面策略校验（§6.3） | 5 s | **排除的工具改名或消失** |
| 7 | 写 `state.json`：`installed=X`、`prev=旧版`、`lastUpgrade.result=ok` | — | — |

第 4 步之所以够用：**venv 路径固定**，`restart` 只是换进程，新进程加载的就是刚装好的代码。不需要重新注册、不需要改配置、工具名不变。

### 4.3 回滚

**以下任一情况立即回滚**，不人工确认（用户已授权：出问题就回滚）：

- 第 1–3 步任一非零退出或超时；
- `restart` 后 60 s 内未 ready；
- 工具面策略校验不通过（见 §6.3，这是最危险的一类，等同「新版本可能打开了沙箱逃生口」）；
- 新实例工具集为空。

回滚动作：`pip install windows-mcp==<prev>` → `restart` → 校验 ready → `state.json` 记 `lastUpgrade.result = "rolled-back"`，`attempts[]` 追加一条失败记录。

回滚后**不自动重试**同一版本；`windows_mcp_status` 与详情页会显示「0.9.0 安装失败已回退至 0.8.8：policy-drift（PowerShell 工具消失）」。

### 4.4 空窗与打扰

- `restart` 会短暂撤掉 `mcp__windows__*`（manager 已知限制，无热替换）。因此在**启动后 30 s 的检查窗口**里做升级，避免撞上进行中的会话；正在执行的工具调用可能报错一次。
- 升级过程的进度写 `logs\provision.log`，详情页显示最后 20 行。
- 失败只做一次提示（状态里可见），不反复弹通知。

### 4.5 手动兜底

- `windows_mcp_update { action: "apply", version?: "0.9.0" }`：强制装指定版本（绕过 24 h 闸门，仍走回滚）。
- `windows_mcp_update { action: "rollback" }`：立刻退回 `prev`。
- `windows_mcp_update { action: "check" }`：只查不装。

## 5 初始化：先探测，缺什么装什么（决议 3 修订）

### 5.1 原则

默认**不打包、不下载**。插件先给机器做体检，把已有的 Python / pip / 引擎找出来直接用；缺什么报什么，附一条可复制的修复命令，由用户决定装不装。

理由：把 200 MB payload 当默认，等于让已经装过 Python 的机器替少数机器买单；而且 payload 里的运行时本身又要跟着插件重新分发一次。

### 5.2 体检项（`windows_mcp_status` 与详情页同源）

| 项 | 探测方式 | 缺失时的提示 |
|---|---|---|
| Python ≥ 3.14 | `py -3.14 -c "import sys;print(sys.version)"`，退化到 `where python` 逐个验 `sys.version_info >= (3,14)` | `winget install Python.Python.3.14` 或 python.org 链接 |
| pip | 该解释器 `-m pip --version` | `python -m ensurepip --upgrade` |
| 引擎 | `venv\Scripts\windows-mcp.exe --version` + `pip show windows-mcp` | 点「初始化」 |
| PyPI 可达 | HEAD `https://pypi.org/simple/`，3 s 超时 | 配代理，或改用离线 wheelhouse |
| 既有 venv | 配置 `engine.attachVenv` | 不提示，直接接管 |

体检结果三态：`ready` / `actionable`（缺东西但能补）/ `blocked`（缺 Python 且用户没动手）。三种状态都写进 `state.json`，重启后不用重新算。

### 5.3 初始化模式（`init.mode`）

| 模式 | 行为 | 默认 |
|---|---|---|
| `detect` | 只探测，不建 venv、不装包，缺什么停在 actionable | |
| `advise` | 探测 + 把修复命令写进状态与详情页，等用户点「初始化」 | **✓ 默认** |
| `setup` | 用探测到的系统 Python 建 venv 并 `pip install windows-mcp==X`（用户点击触发） | |
| `auto` | 允许在系统没有 3.14 时下载便携运行时，并自动建环境 | 可选开关 |

关键：**便携运行时只在 `auto` 且系统确实没有 3.14 时才下载**，它是兜底，不是主路径。

### 5.4 运行时来源（新优先级）

1. **系统 Python ≥ 3.14**（`py -3.14` / `where python` / `config.pythonPath`）→ 用它 `-m venv`。
2. **`config.engine.attachVenv`**：迁移期可指向既有 venv（如 `D:\mcp\Windows_MCP\.venv`），零拷贝接管。
3. **便携运行时**（`payload/` 或 `auto` 下载）→ 仅当前两者都没有。

三档都不可用时不降级、不静默，状态置 `blocked` 并给出指引。

### 5.5 成本（按模式）

| 模式 | 插件包 | 磁盘增量 | 首次耗时 |
|---|---|---|---|
| `advise`（默认，系统已有 3.14） | ≈200 KB | 0（未初始化） | 0 |
| `setup` | ≈200 KB | venv 212 MB | 60–150 s |
| `auto`（系统没 3.14） | ≈200 KB | +50–70 MB 运行时 | 2–3 分钟 |
| 离线 payload | 150–250 MB | 同上 | ≈1 分钟（本地解压） |

可行性依据不变：`pillow`/`numpy` 有 `cp314-win_amd64` 轮子、`pywin32` 是 `py3-none-any`、`comtypes` 纯 Python → 零编译、无需管理员权限。

### 5.6 分发形态

| 形态 | 适用 | 体积 | 安装动作 |
|---|---|---|---|
| 目录拷贝 | 1–3 台 | ≈200 KB | Plugins → Add plugin → 选目录 |
| `npm pack` / 私有 registry | 小团队 | ≈200 KB | 同上 |
| 内网 market index | 全员 | ≈200 KB | 加一次 index URL，之后 Discover 点装 |
| 带 payload 的目录 | 无外网**且**无 Python | 150–250 MB | 目录拷贝，装完点一次初始化 |

**默认发 200 KB 那个，payload 是例外。** `install_bundle` 只吃本地目录，所以「给别人」= 给一个目录；market index 是它的自动化外壳。

## 6 工具面策略与漂移检测

### 6.1 现在的防线

`--exclude-tools PowerShell,Registry,FileSystem,Process` 是**安全边界**：否则这台 MCP 能直接读写文件、起进程，绕过 DSH 的文件沙箱。

### 6.2 漂移风险（自动更新的最大坑）

这套排除是**按名字**生效的。上游哪天把 `PowerShell` 改成 `Shell`、或新增一个 `Run` 工具，排除清单会**静默失效**——你升级完不但没报错，还多了一个未受约束的执行工具。这是「允许自动装」之后唯一可能造成实际损害的场景。

### 6.3 校验算法

升级后拿 `probe()` 的真实工具名清单，跑三道检查：

1. **点名检查**：`PowerShell/Registry/FileSystem/Process` 必须仍然存在于工具集中。若某个从工具集里**消失**，说明被改名或删除 → 判 `drift`。
2. **关键词检查**：工具集里出现任何匹配 `/(shell|powershell|cmd|exec|command|run|process|registry|file|fs|read|write|delete)/i` 的**新增**名字 → 判 `drift`。
3. **模式检查**：`strict: true` 时用允许清单（只放行已确认安全的工具名），任何未知名字都判 `drift`。

判定为 `drift` 时按 §4.3 回滚，并在状态里写清「哪个名字导致回滚」。`state.toolNames` 记录每次版本的工具集，详情页可 diff。

## 7 迁移与下线

### 7.1 冲突点

静态行的 `serverName` 也是 `windows`，与插件注册同名会**被 manager 拒绝**。所以顺序不能颠倒：**先停旧行，再装插件**。

### 7.2 步骤

1. 装插件，首次激活自动供给运行时（2–3 分钟），此阶段工具尚不可用。
2. 停用 profile 里的 `mcp-windows` 静态行（`disabled: true`）。
3. 插件注册 `windows` → `mcp__windows__*` 恢复。
4. 跑一次 `windows_mcp_status`：确认 `installed` 是自管版本、`runtime.source` 是自己供给的。
5. 删 `D:\mcp\Windows_MCP` 与 opencode 里的 mcp 配置。
6. 断网重启 DSH，工具仍可用 → 迁移完成。

### 7.3 回退

旧目录删之前先留 7 天；插件的 `prev` 版本 + `cache\wheelhouse` 足以在不联网的情况下退回上一版引擎。插件本身出问题则停用插件、恢复 `mcp-windows` 静态行即可 —— 两条路互不影响。

## 8 风险与未验证

| # | 项 | 状态 | 处理 |
|---|---|---|---|
| 1 | `mcpManager.register()` 精确签名（asar 未打包 `lib/types/index.d.ts`） | **未验证** | 实施前从 `src/` 或 README 确认，必要时 disposer + 重注册 |
| 2 | `restart()` 对插件注册的实例是否等效 | **未验证** | 用 0.8.8→0.9.0 当第一次真实验证 |
| 3 | 便携 CPython 3.14 资产的确切 URL/文件名 | **未验证**（GitHub API 403） | 只在 `auto`/payload 场景才需要；需要时解析一次并固化 URL+SHA256 |
| 4 | 企业网代理 | 未测 | pip 继承 `HTTP(S)_PROXY`；Host 环境变量需透传，写进 `blocked` 诊断 |
| 5 | 杀软对下载的 `python.exe` 误报 | 未遇到 | 默认不下载就不会遇到；仅 `auto`/payload 模式提示 |
| 6 | DSH 升级改动 mcpManager API | 已知 | peer 依赖是 `0.2.2-rc.5`；插件对 inject 失败要给出可读错误 |
| 7 | 目标机没有 Python 3.14 且用户不想装 | 设计取舍 | 状态置 `blocked` + 给三条出路（winget / python.org / `auto` 下载） |
| 8 | 目标机有多个 Python 版本 | 未测 | 体检逐个 `sys.version_info` 验版本，**不取第一个 PATH 命中**；必要时 `config.pythonPath` 显式指定 |
| 9 | 用户装的是商店版 Python | 未测 | 商店版 `python.exe` 走 App Execution Alias，可能弹窗或返回 stub；体检里识别并提示换官方安装包 |
| 10 | `engine.attachVenv` 让插件又依赖外部目录 | 设计取舍 | 只作迁移期加速手段，默认关闭；`windows_mcp_status` 明示「当前挂在外部 venv 上，不可分发」 |

## 9 里程碑

| 阶段 | 内容 | 估时 |
|---|---|---|
| M1 | bundle 骨架 + 体检（`detect/advise`）+ 按探测结果建 venv + `mcpManager.register` | 2 天 |
| M2 | 更新器：check / apply / rollback + 策略校验 + `state.json` | 2 天 |
| M3 | 分发：详情页 + 内网 index；`auto` 与离线 payload 作为可选分支 | 1 天 |
| M4 | 迁移：下线旧行、断网验收、给同事的安装说明 | 0.5 天 |

合计 ≈ 5.5 天（含实测验证）。默认交付形态是 200 KB 的目录包，`payload` 只在无外网场景按需追加。

## 10 实现状态（2026-11-24）

M1–M4 已实现，代码在仓库根目录（`index.js` + `lib/`），纯逻辑自检见 `test/logic.mjs`（16 项）。真机行为由使用方在目标机器验证。

| 里程碑 | 状态 | 落点 |
|---|---|---|
| M1 骨架 / 探测 / 供给 / 注册 | 完成 | `index.js`、`lib/{detect,engine,status,state}.js` |
| M2 更新器 / 回滚 / 漂移检测 | 完成 | `lib/{update,upstream,probe,policy}.js` |
| M3 分发 / 离线 payload / 文档 | 完成 | `scripts/pack.mjs`、`lib/payload.js`、`docs/INSTALL.md` |
| M4 迁移指引 / 冲突检查 | 完成 | `scripts/migration-check.mjs`、`docs/MIGRATION.md` |

与设计的两处偏离（均有依据）：

1. **`register()` 的返回值**按「可能是 disposer」处理：是函数就留着，卸载/U 盘时调用；不是也能正常工作。原因是 asar 内未分发该方法的 `.d.ts`。
2. **wheel 哈希校验**没有用 `pip --require-hashes`（要求整条依赖闭包都命中哈希，维护成本高），改为升级前从 PyPI JSON 取目标 wheel 的 sha256 并在日志与记录中留存；传递依赖仍由 pip 正常解析。**这是有意的弱化，记录在此**。

### 10.1 修正记录

- **2026-11-24 · v1.0.1 · state.json 快照不刷新**：`detect` 段原先只在激活末尾写一次，
  `windows_mcp_setup`、`registerEngine()`、`update` 的 apply/rollback 都不回写，
  导致文件自相矛盾（`installed: 0.9.0` 与 `engine: none` 并存）。
  现在快照统一由 `plugin/lib/snapshot.js` 的 `buildDetectState()` 生成（含 §5.2 的三态
  `health: ready|actionable|blocked`），所有会改变体检结果的路径都调用 `persistDetect()`；
  回归用例在 `test/logic.mjs`（6 项）。
