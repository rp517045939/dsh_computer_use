/**
 * Status model and its text rendering.
 *
 * One shape feeds both the model-facing `windows_mcp_status` tool and the plugin
 * detail page, so the terminal and the browser never disagree.
 */

import { assessHealth } from './snapshot.js'

function mark(flag) {
  return flag ? 'OK' : 'MISSING'
}

function ago(isoTimestamp) {
  if (typeof isoTimestamp !== 'string') return ''
  const at = Date.parse(isoTimestamp)
  if (!Number.isFinite(at)) return ''
  const minutes = Math.round((Date.now() - at) / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 90) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} h ago`
  return `${Math.round(hours / 24)} d ago`
}

/**
 * @param {{
 *   config: object,
 *   engine: object,
 *   python: object|null,
 *   pythonRejected: object[],
 *   pip: object|null,
 *   channel: object|null,
 *   registration: object,
 *   updateState: object,
 *   payload: object,
 *   pluginVersion: string,
 * }} input
 */
export function buildStatus(input) {
  const { config, engine, python, pythonRejected, pip, channel, registration, updateState, payload, pluginVersion } = input
  const installed = engine.version ?? null
  const latest = channel?.ok === true ? channel.latest : null
  const outdated = installed !== null && latest !== null && latest !== installed

  const hints = []
  if (python === null) {
    hints.push('No Python >= 3.14 found. Install it with: winget install Python.Python.3.14')
    hints.push('After installing, run windows_mcp_setup (or restart DSH) to create the engine venv.')
  } else if (pip !== null && pip.ok === false) {
    hints.push(`That interpreter has no working pip: ${pip.reason}. Repair with: ${python.path} -m ensurepip --upgrade`)
  }
  if (engine.mode === 'none' && python !== null) {
    hints.push('Engine not provisioned yet. Run windows_mcp_setup, or set engine.attachVenv to reuse an existing venv.')
  }
  if (engine.mode === 'attach') {
    hints.push(`Attached to an external venv at ${engine.venvDir}: convenient for migration, but not self-contained.`)
  }
  if (registration.registered !== true && engine.mode !== 'none') {
    hints.push(registration.reason ?? 'Engine is present but the MCP server is not registered.')
  }
  if (outdated) {
    hints.push(`Upstream release ${latest} is newer than the installed ${installed}.${config.update.auto ? ' Automatic update is enabled.' : ' Run windows_mcp_update with action apply to install it.'}`)
  }
  if (channel?.ok === false) {
    hints.push(`Release channel unreachable: ${channel.error}. Local operation is unaffected.`)
  }

  return {
    plugin: { name: 'dsh-windows-mcp', version: pluginVersion },
    health: assessHealth({ python, pip, engine, registration }),
    init: { mode: config.initMode },
    server: {
      name: config.serverName,
      registered: registration.registered === true,
      command: engine.mode === 'none' ? '' : registration.command ?? '',
    },
    engine: { mode: engine.mode, venvDir: engine.venvDir, version: installed },
    python: python === null ? null : { version: python.version, path: python.path, source: python.source },
    pythonRejected,
    pip,
    channel: {
      latest,
      installed,
      outdated,
      yanked: channel?.yanked ?? false,
      error: channel?.ok === false ? channel.error : null,
      checkedAt: channel?.checkedAt ?? null,
    },
    update: {
      auto: config.update.auto === true,
      previous: typeof updateState?.previous === 'string' ? updateState.previous : null,
      lastUpgrade: updateState?.lastUpgrade ?? null,
      recentAttempts: Array.isArray(updateState?.attempts) ? updateState.attempts.slice(-3) : [],
      toolCount: Array.isArray(updateState?.toolNames) ? updateState.toolNames.length : null,
    },
    payload: payload === undefined || payload === null ? null : { dir: payload.dir, exists: payload.exists, wheelhouse: payload.wheelhouse, python: payload.python },
    paths: { engineDir: config.engineDir, venvDir: config.venvDir, attachVenv: config.attachVenv },
    hints,
  }
}

/** Human-readable, terminal-shaped report. */
export function renderStatus(status) {
  const lines = []
  const python = status.python
  lines.push(`dsh-windows-mcp ${status.plugin.version}  (init.mode=${status.init.mode}, health=${status.health})`)
  lines.push('')
  lines.push(`server      ${status.server.name}  ${status.server.registered ? 'registered' : 'not registered'}`)
  lines.push(`engine      ${status.engine.mode}  ${status.engine.version ?? '(version unknown)'}`)
  lines.push(`engine dir  ${status.paths.engineDir}`)
  lines.push(`venv        ${status.engine.venvDir}`)
  if (status.server.command !== '') lines.push(`command     ${status.server.command}`)
  lines.push('')
  lines.push(`python      ${python === null ? mark(false) : `${mark(true)}  ${python.version}  ${python.path}`}`)
  if (python !== null) lines.push(`            found via ${python.source}`)
  lines.push(`pip         ${status.pip === null ? '(not checked)' : status.pip.ok ? `OK  ${status.pip.version ?? ''}` : `MISSING  ${status.pip.reason ?? ''}`}`)
  if (status.payload !== null) {
    lines.push(`payload     ${status.payload.exists ? `present  ${status.payload.dir}` : 'absent (online install)'}`)
  }

  const channel = status.channel
  if (channel.error !== null) lines.push(`release     (unavailable: ${channel.error})`)
  else if (channel.latest === null) lines.push('release     (not checked)')
  else lines.push(`release     latest ${channel.latest}${channel.outdated ? '  <- newer than installed' : '  (up to date)'}${channel.checkedAt === null ? '' : `  checked ${ago(channel.checkedAt)}`}`)

  const last = status.update.lastUpgrade
  const lastText = last === null || last === undefined
    ? 'none yet'
    : `${last.from ?? '?'} -> ${last.to}  ${last.result}${last.at === undefined ? '' : `  ${ago(last.at)}`}`
  lines.push(`update      auto ${status.update.auto ? 'on' : 'off'}  last: ${lastText}`)
  if (status.update.toolCount !== null) lines.push(`tool surface ${status.update.toolCount} tools recorded`)
  for (const attempt of status.update.recentAttempts) {
    if (attempt?.result === 'ok') continue
    lines.push(`            attempt ${attempt?.version ?? '?'} ${attempt?.result ?? ''} ${attempt?.reason === undefined ? '' : `(${attempt.reason})`}`.trimEnd())
  }

  if (status.pythonRejected.length > 0) {
    lines.push('')
    lines.push('rejected interpreters')
    for (const item of status.pythonRejected) {
      lines.push(`  - ${item.command}  ${item.version ?? ''}  ${item.reason ?? ''}`.trimEnd())
    }
  }
  if (status.hints.length > 0) {
    lines.push('')
    lines.push('next')
    for (const hint of status.hints) lines.push(`  * ${hint}`)
  }
  return lines.join('\n')
}
