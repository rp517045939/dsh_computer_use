# 从手工 MCP 迁移到插件

目标：让插件接管 `mcp__windows__*`，然后删掉手工维护的 MCP 配置与它的 venv。

## 迁移前

```powershell
node scripts/migration-check.mjs          # 只读，不写任何文件
```

它会告诉三件事：profile 里还有哪些静态 `dsh-mcp-client` 行、哪一行占着
`serverName: windows`、插件当前用的是哪个名字。

典型输出（迁移前）：

```
static MCP client rows in the profile:
  - id=mcp-windows serverName=windows  <- ...\profiles\desktop\cordis.patch.yml
MIGRATION NEEDED: an active static row already owns serverName "windows".
```

## 两种情况

**A. 全新机器**（没有旧的 `dsh-mcp-client` 行）

插件默认 `serverName: windows`，装完 `windows_mcp_setup` 就能直接用，无需迁移。

**B. 已经有手工 MCP 的机器**（本机属于这种）

`serverName` 默认值会撞车，按下面四步走。

### 第 1 步：先停旧行

在 Plugins 里把旧的 `mcp-windows` 行停用；或在 profile 的 `cordis.patch.yml` 里给同一 id 补一行：

```yaml
- id: mcp-windows
  disabled: true
```

停用后 `serverName: windows` 空出来。**必须先停**：MCP 管理器不允许两个实例共用一个名字，插件会明确报 `register() refused`。

### 第 2 步：装插件并配好引擎

把插件目录加进 Plugins，然后让模型执行 `windows_mcp_setup`（或 `init.mode: setup` 让它自己建）。
此时若还没停旧行，插件会以「未注册」状态存在，工具不可用——这是预期状态，不是坏掉了。

### 第 3 步：验证

新会话里执行 `windows_mcp_status`，四个字段都要对：

```
server      windows  registered
engine      managed  0.9.0
python      OK  3.14.x  <解释器路径>
release     latest 0.9.x  (up to date)
```

再实际调一次 `mcp__windows__ControlStatus` 确认能响应。

### 第 4 步：清理旧资产

确认稳定运行几天后再删：

```powershell
Remove-Item 'D:\mcp\Windows_MCP' -Recurse      # 旧的 venv
# 以及 opencode / cursor 里那条 mcp 配置
```

删之前，旧配置随时可以恢复——插件与它是两条独立的路。

## 回退

任何一步不对，回到旧状态只有一个动作：**停用插件，恢复 `mcp-windows` 行**。
插件的 venv 留在 `$DSH_HOME\windows-mcp\venv`，不影响旧路径；反过来也一样。

## 不要做的事

- **不要**让插件的 `engine.attachVenv` 长期指向旧 venv。它能加速迁移，但那样插件就不再自包含，换台机器就废了；状态页会明写这一点。
- **不要**同时保留两个同名实例。撞名时管理器拒绝注册，比「两个实例抢桌面」安全，但仍应尽快清理。
