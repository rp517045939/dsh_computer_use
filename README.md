# dsh-windows-mcp

Windows desktop automation as **one DeepSeek Harness plugin**.

The plugin owns its engine instead of depending on a hand-maintained MCP entry: it
detects a Python interpreter, creates a private virtual environment, installs the
upstream [Windows-MCP](https://github.com/CursorTouch/Windows-MCP) engine into it,
registers that engine with the Host's MCP manager, and keeps it on the release
channel with verified upgrades and automatic rollback.

Once installed, the model gets the usual desktop tools — `mcp__windows__Snapshot`,
`Click`, `Type`, `Scroll`, `App`, `Clipboard`, … — with no MCP row to maintain.

- [Requirements](#requirements)
- [Install from GitHub](#install-from-github)
- [Update](#update)
- [Install from a local directory](#install-from-a-local-directory)
- [First run](#first-run)
- [Configuration](#configuration)
- [How an engine upgrade is accepted](#how-an-engine-upgrade-is-accepted)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

## Requirements

| Item | Requirement | Notes |
|---|---|---|
| OS | Windows 10/11 x64 | The engine drives UI Automation |
| Python | 3.14+ | Missing interpreters are reported, not downloaded, unless `init.mode: auto` |
| Network | PyPI on first setup | An offline payload removes this |
| DSH | A build that provides `ctx.mcpManager` and `ctx.tools` | Desktop and Web profiles do |

## Install from GitHub

The repository root **is** the bundle package, so a Git spec installs it directly —
no clone, no subdirectory.

Ask the agent (or call the tool yourself):

```
plugin_manager  action: install_bundle
                target: github:rp517045939/dsh_computer_use#v1.0.1
```

`#v1.0.1` is the release tag; any committish works (`#main` for the tip, or a full
40-character commit SHA). DSH pins a full commit as an *updatable* Git dependency —
see [Update](#update). If your build rejects the `github:` shortcut, the full URL
form works the same way:

```
target: https://github.com/rp517045939/dsh_computer_use.git#v1.0.1
```

The same operation is available in **Plugins → Add plugin** when the page accepts an
installation spec. `<owner>/<repo>#<ref>` is resolved by the profile's package
manager, so the machine needs `git` and network access to GitHub.

Verify it landed:

```
plugin_manager  action: list_bundles
```

The bundle appears as `dsh-windows-mcp` with its version and enabled state.

## Update

Plugin code changes are installed from a newer ref. `install_bundle` refuses an
already-installed bundle, so the flow is remove, then install the new ref:

```
plugin_manager  action: remove_bundle    target: dsh-windows-mcp
plugin_manager  action: install_bundle   target: github:rp517045939/dsh_computer_use#v1.0.2
```

Every release in [CHANGELOG.md](CHANGELOG.md) names its ref. Your configuration
survives the reinstall because the bundle row id and your profile patch do not change.

If you installed a **full 40-character commit** instead of a tag, your DSH build can
also list the bundle as `updatable: git` and replace it with a new commit-pinned spec
in one step. A tag or branch spec is not updatable that way — use the two calls above.

**Engine updates need none of this.** The plugin follows PyPI releases by itself
(`update.auto: true`): it verifies the wheel, handshakes the new engine, re-checks the
tool surface, and only then swaps the live instance — rolling back by itself if
anything fails. See [How an engine upgrade is accepted](#how-an-engine-upgrade-is-accepted).

## Install from a local directory

Useful offline, or when a DSH build does not accept Git specs.

```powershell
node scripts/pack.mjs                 # → dist/dsh-windows-mcp/
```

Then **Plugins → Add plugin** and pick `dist/dsh-windows-mcp`. To ship an offline
installer, place a payload first — see [docs/INSTALL.md](docs/INSTALL.md).

## First run

1. Confirm Python 3.14 if the machine has none:
   ```powershell
   winget install Python.Python.3.14
   ```
2. In a new session, either run `windows_mcp_setup`, or set `init.mode: setup` and
   let activation provision the venv (2–3 minutes, ~210 MB).
3. Check with `windows_mcp_status` — `server registered`, `engine managed <version>`,
   `python OK` — then call `mcp__windows__ControlStatus` once.

## Configuration

Defaults ship in [cordis.patch.yml](cordis.patch.yml). The fields most people change:

```yaml
- id: windows-mcp
  name: "dsh-windows-mcp"
  config:
    serverName: windows         # tool namespace → mcp__windows__*
    init:
      mode: advise              # detect | advise | setup | auto
    engineVersion: "0.9.0"      # version installed on first setup
    update:
      auto: true                # unattended engine upgrades, with rollback
    tools:
      exclude: [PowerShell, Registry, FileSystem, Process]
```

| Field | Default | Meaning |
|---|---|---|
| `serverName` | `windows` | Must not collide with another MCP instance |
| `init.mode` | `advise` | `advise` reports; `setup` provisions at activation; `auto` may also download a runtime |
| `engine.dir` | `$DSH_HOME/windows-mcp` | venv and diagnostics |
| `engine.attachVenv` | empty | Reuse an existing venv during migration; not self-contained |
| `python.path` / `python.minVersion` | empty / `3.14` | Interpreter override and floor |
| `tools.exclude` | 4 process/file tools | Names removed from the served surface |
| `update.auto` | `true` | Install newer releases unattended |
| `update.debounceHours` / `maxAttempts` | `24` / `2` | Upgrade pacing and retry budget |
| `payload.dir` | `<package>/payload` | Offline interpreter and/or wheelhouse |

## How an engine upgrade is accepted

1. Query PyPI for the newest release (the GitHub release feed only cross-checks the
   tag; the unauthenticated GitHub REST API is deliberately unused).
2. Install it and probe it *before* touching the live instance: the engine must
   complete an MCP handshake.
3. Compare the tool surface twice — with and without `--exclude-tools`. A renamed or
   vanished excluded tool, or an exclusion that removes nothing, fails the upgrade.
4. Restart the instance. Any failure installs the previous version back and records
   why; a version that failed twice is not retried automatically.

## Troubleshooting

Start with `windows_mcp_status` and read it top-down.

| Symptom | Meaning | Action |
|---|---|---|
| `python MISSING` | No Python 3.14 | `winget install Python.Python.3.14`, then `windows_mcp_setup` |
| `pip MISSING` | Interpreter without pip | `python -m ensurepip --upgrade` |
| `engine none` | Not provisioned | `windows_mcp_setup`, or `init.mode: setup` |
| `not registered` + `register() refused` | Another MCP instance owns the name | Disable that row, or set `serverName: winmcp` |
| `update … failed:policy` | New engine broke the exclusion policy | Already rolled back; review `tools.exclude` against upstream renames |
| `release (unavailable)` | PyPI unreachable | Configure a proxy, or use an offline payload |

`node scripts/migration-check.mjs` reports, read-only, which profile rows own the
`windows` namespace.

More: [docs/INSTALL.md](docs/INSTALL.md) (offline payload, proxy),
[docs/MIGRATION.md](docs/MIGRATION.md) (from a hand-written MCP row),
[docs/DESIGN.md](docs/DESIGN.md) (design record and decisions).

## Development

Requirements: Node.js 20+; a Windows machine with Python 3.14 for engine work.

```powershell
node test/logic.mjs      # pure logic: version gates, tool-surface policy, snapshots
node scripts/pack.mjs    # build dist/
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for layout, ground rules, and the release
process. Engine-facing scripts (`test/provision.mjs`, `test/engine-handshake.mjs`)
are opt-in and never run in CI.

## License

[MIT](LICENSE). The engine is installed from PyPI and remains
[CursorTouch/Windows-MCP](https://github.com/CursorTouch/Windows-MCP), also MIT.
