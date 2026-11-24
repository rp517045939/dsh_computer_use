# Contributing

Thanks for taking a look. This repository is a single DSH bundle: the package root
**is** the plugin, so what you see at the top level is what DSH installs.

## Layout

| Path | Role |
|---|---|
| `index.js` | Host plugin entry: detection, provisioning, registration, tools |
| `lib/` | Dependency-free modules (engine, updater, policy, status, snapshot, …) |
| `cordis.patch.yml` | The bundle's Loader patch and every configuration default |
| `locale/`, `icon.svg`, `docs/DETAIL.md` | Display metadata shown in Plugins |
| `docs/` | Install, migration, and design documents |
| `scripts/` | Packaging and migration-check helpers |
| `test/` | Optional self-checks; not required to run the plugin |

## Ground rules

- **No runtime dependencies.** Everything uses Node built-ins. A published bundle
  that pulls a dependency into a Host process is a much larger review surface.
- **No hidden writes.** A tool or activation path may write only inside
  `engine.dir`, `state.json`, and the venv it owns.
- **Verify before promoting.** Any change to the upgrade path must keep the
  handshake + tool-surface check in front of the live instance.
- **Fail closed on policy.** If the engine's tool surface stops honouring
  `tools.exclude`, refuse the version; do not widen the surface silently.

## Development

Requirements: Node.js 20 or newer, and (only for real engine work) Windows with
Python 3.14 available.

```powershell
node --check index.js          # syntax
node test/logic.mjs            # pure logic: version gates, policy, snapshots
node scripts/pack.mjs          # build a distributable copy under dist/
```

`test/smoke.mjs`, `test/provision.mjs`, and `test/engine-handshake.mjs` touch the
network, create a virtual environment, or start the engine. They are opt-in and
should not run in CI.

## Releases

1. Bump `version` in `package.json` and add a `CHANGELOG.md` entry.
2. Commit, then tag `vX.Y.Z` and push the tag.
3. Point the README install block at the new tag.
4. Put the full 40-character commit SHA in the release notes: consumers who want
   DSH's one-step `update: git` path must install a commit-pinned spec, and a tag
   spec is not updatable that way.

## Pull requests

Keep changes scoped, run `node test/logic.mjs`, and say what you could not verify
(for example, behaviour that needs a Windows desktop). Screenshots or logs of the
Plugins page are welcome for display-metadata changes.
