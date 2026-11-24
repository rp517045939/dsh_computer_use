# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.1] - 2026-11-24

### Fixed

- `state.json` kept the activation-time health snapshot: `windows_mcp_setup`,
  registration, and release updates changed the runtime state without rewriting it,
  so the file could report `installed: 0.9.0` beside `engine: none`.
  The snapshot is now built by one pure function and rewritten by every path that
  changes what a probe would report.
- The persisted snapshot now carries the design's three-state health
  (`ready` / `actionable` / `blocked`), shown in `windows_mcp_status` as well.

### Added

- Six regression cases for health assessment and snapshot freshness.

## [1.0.0] - 2026-11-24

### Added

- Release-channel updater: PyPI is the authority, the GitHub release feed only
  cross-checks the tag. No GitHub REST API call, so a rate-limited IP cannot break
  checks.
- Verified promotion: wheel digest lookup, an MCP handshake against the installed
  engine, and a two-probe tool-surface comparison (with and without
  `--exclude-tools`) before the live instance is touched.
- Automatic rollback to the previous version on any failed step, with a per-version
  attempt budget so a broken release is not retried forever.
- MCP registration through `ctx.mcpManager`, keeping the tool namespace the
  hand-written `dsh-mcp-client` row used.
- Offline payload support: a portable interpreter and/or wheelhouse beside the
  package installs without PyPI access.
- `windows_mcp_status`, `windows_mcp_setup`, and `windows_mcp_update` tools.
- `scripts/pack.mjs` for building a distributable copy, and
  `scripts/migration-check.mjs` for a read-only check of the `windows` tool
  namespace before migrating from a hand-managed MCP row.

### Changed

- Default `serverName` is `windows`, matching the conventional MCP row, so prompts
  and skills keep working after migration.

[Unreleased]: https://github.com/rp517045939/dsh_computer_use/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/rp517045939/dsh_computer_use/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/rp517045939/dsh_computer_use/releases/tag/v1.0.0
