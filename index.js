/**
 * dsh-windows-mcp — Windows desktop automation as one plugin.
 *
 * The plugin owns its engine instead of depending on a hand-managed MCP entry: it
 * detects a Python interpreter, provisions (or attaches) a venv, installs the
 * upstream Windows-MCP release into it, registers that engine with the Host's MCP
 * manager, and keeps it on the release channel with automatic rollback.
 *
 * Activation is side-effect free unless configured otherwise: `init.mode` decides
 * whether anything gets installed, and `update.auto` decides whether a newer
 * release is applied unattended.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { normalizeConfig } from './lib/config.js'
import { detectPip, detectPython } from './lib/detect.js'
import { createVenv, installEngine, registerEntry, resolveEngine } from './lib/engine.js'
import { describePayload, resolvePayload } from './lib/payload.js'
import { probeEngine } from './lib/probe.js'
import { patchState, readState } from './lib/state.js'
import { buildStatus, renderStatus } from './lib/status.js'
import { buildDetectState } from './lib/snapshot.js'
import { loadDefineTool, plainDefinition } from './lib/tools-api.js'
import { autoApplyGate, checkForUpdate, rollback, upgrade } from './lib/update.js'

export const name = 'dsh-windows-mcp'
export const inject = ['mcpManager', 'tools']

const PACKAGE_DIR = fileURLToPath(new URL('.', import.meta.url))
const STARTUP_CHECK_DELAY_MS = 30000

const PLUGIN_VERSION = readPluginVersion()

function readPluginVersion() {
  try {
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function errorText(error) {
  return String(error?.message ?? error)
}

export async function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  const payload = resolvePayload(config, PACKAGE_DIR)
  const log = (line) => {
    try {
      ctx.logger?.info?.(`[windows-mcp] ${line}`)
    } catch {
      // Logging must never fail activation.
    }
  }

  /** Shared mutable view of this activation. */
  const runtime = {
    config,
    payload,
    python: null,
    pythonRejected: [],
    pip: null,
    channel: null,
    engine: resolveEngine(config),
    registration: { registered: false, reason: 'not attempted yet', command: '' },
    dispose: null,
    tools: { registered: false, names: [], reason: 'not attempted yet', via: 'none' },
  }

  const store = {
    read: () => readState(config),
    patch: (value) => patchState(config, value),
  }

  /**
   * Rewrite the persisted health snapshot from the current in-memory truth.
   *
   * Every path that changes what a probe would report — provisioning, registering,
   * unregistering, upgrading, rolling back — calls this, so `state.json` never
   * contradicts itself (for example "installed 0.9.0" next to "engine: none").
   */
  function persistDetect() {
    try {
      runtime.engine = resolveEngine(config)
      const current = store.read()
      store.patch({
        ...buildDetectState({
          python: runtime.python,
          pythonRejected: runtime.pythonRejected,
          pip: runtime.pip,
          engine: runtime.engine,
          registration: runtime.registration,
          tools: runtime.tools,
          payload,
        }),
        installed: runtime.engine.version ?? current.installed ?? null,
        previous: current.previous ?? null,
      })
    } catch (error) {
      log(`state write skipped: ${errorText(error)}`)
    }
  }

  // ---------------------------------------------------------------- detection

  async function refreshLocal() {
    const extra = payload.python === '' ? [] : [{ command: payload.python, args: [], source: 'payload runtime' }]
    const detection = await detectPython(config, extra)
    runtime.python = detection.python
    runtime.pythonRejected = detection.rejected
    runtime.pip = detection.python === null ? null : await detectPip(detection.python.path)
    runtime.engine = resolveEngine(config)
    return detection
  }

  // ------------------------------------------------------------- registration

  function currentEngine() {
    runtime.engine = resolveEngine(config)
    return runtime.engine
  }

  function registerEngine() {
    const engine = currentEngine()
    if (engine.mode === 'none') {
      runtime.registration = { registered: false, reason: engine.reason ?? 'no engine available', command: '' }
      persistDetect()
      return false
    }
    const entry = registerEntry(config, engine)
    const command = `${entry.command} ${entry.args.join(' ')}`
    try {
      const disposer = ctx.mcpManager.register(config.serverName, entry)
      runtime.dispose = typeof disposer === 'function' ? disposer : null
      runtime.registration = { registered: true, reason: '', command }
      log(`registered MCP server "${config.serverName}" -> ${command}`)
      persistDetect()
      return true
    } catch (error) {
      runtime.registration = {
        registered: false,
        reason: `register() refused "${config.serverName}": ${errorText(error)}. A static dsh-mcp-client row may already own that name; disable it (or choose another serverName) and reload.`,
        command,
      }
      log(runtime.registration.reason)
      persistDetect()
      return false
    }
  }

  function unregisterEngine() {
    if (runtime.registration.registered !== true) return
    try {
      runtime.dispose?.()
    } catch (error) {
      log(`unregister failed: ${errorText(error)}`)
    }
    runtime.dispose = null
    runtime.registration = { registered: false, reason: 'unregistered', command: runtime.registration.command }
    persistDetect()
  }

  async function restartServer() {
    try {
      if (typeof ctx.mcpManager.restart === 'function') {
        await ctx.mcpManager.restart(config.serverName)
        return { ok: true, error: '' }
      }
    } catch (error) {
      log(`mcpManager.restart failed, re-registering instead: ${errorText(error)}`)
    }
    unregisterEngine()
    const ok = registerEngine()
    return { ok, error: ok ? '' : runtime.registration.reason }
  }

  // -------------------------------------------------------------- provisioning

  async function provision(reason) {
    if (runtime.python === null) {
      runtime.registration = { registered: false, reason: 'cannot provision: no Python >= 3.14 (and no payload runtime)', command: '' }
      persistDetect()
      return false
    }
    log(`provisioning engine (${reason}) with Python ${runtime.python.version} at ${runtime.python.path}`)
    const venv = await createVenv(config, runtime.python.path)
    if (!venv.ok) {
      const message = venv.timedOut ? 'venv creation timed out' : venv.error || 'venv creation failed'
      runtime.registration = { registered: false, reason: message, command: '' }
      log(message)
      persistDetect()
      return false
    }
    const install = await installEngine(config, log, { version: config.engineVersion, wheelhouse: payload.wheelhouse })
    if (!install.ok) {
      const message = install.timedOut ? 'pip install timed out' : install.error || `pip install failed (exit ${install.code})`
      runtime.registration = { registered: false, reason: message, command: '' }
      log(message)
      persistDetect()
      return false
    }
    runtime.engine = resolveEngine(config)
    persistDetect()
    log(`engine ready: ${config.venvDir} (version ${runtime.engine.version ?? 'unknown'})`)
    return true
  }

  // ------------------------------------------------------------------ updates

  const ops = {
    installedVersion: () => {
      const engine = resolveEngine(config)
      return engine.version
    },
    currentEngine: () => resolveEngine(config),
    pipInstall: (version) => installEngine(config, log, { version, wheelhouse: payload.wheelhouse }),
    probe: (entry) => probeEngine(entry),
    restartServer,
    serverStatus: () => {
      try {
        return typeof ctx.mcpManager.list === 'function' ? ctx.mcpManager.list() : null
      } catch {
        return null
      }
    },
  }

  const updateContext = { config, log, store, ops }

  async function runCheck() {
    runtime.channel = await checkForUpdate(updateContext)
    try {
      store.patch({ channel: { latest: runtime.channel.latest, checkedAt: runtime.channel.checkedAt, error: runtime.channel.error } })
    } catch (error) {
      log(`state write skipped: ${errorText(error)}`)
    }
    return runtime.channel
  }

  async function maybeAutoUpdate() {
    if (config.update.auto !== true) return null
    const check = await runCheck()
    const gate = autoApplyGate({ config, state: store.read(), check })
    if (!gate.allowed) {
      log(`auto update skipped: ${gate.reason}`)
      return null
    }
    log(`auto update: ${check.installed ?? '(unknown)'} -> ${check.latest}`)
    const result = await upgrade(updateContext, check.latest)
    log(`auto update ${result.result}: ${result.reason || 'ok'}`)
    runtime.engine = resolveEngine(config)
    persistDetect()
    return result
  }

  // ------------------------------------------------------------------- status

  function currentStatus() {
    return buildStatus({
      config,
      engine: runtime.engine,
      python: runtime.python,
      pythonRejected: runtime.pythonRejected,
      pip: runtime.pip,
      channel: runtime.channel,
      registration: runtime.registration,
      updateState: store.read(),
      payload,
      pluginVersion: PLUGIN_VERSION,
    })
  }

  // -------------------------------------------------------------------- tools

  function makeTool(resolved, spec) {
    if (resolved.defineTool !== null) {
      return resolved.defineTool({
        name: spec.name,
        description: spec.description,
        parameters: spec.dsl,
        output: spec.output,
        execute: spec.execute,
      })
    }
    return plainDefinition({
      name: spec.name,
      description: spec.description,
      parameters: spec.jsonSchema,
      output: spec.output,
      execute: spec.execute,
    })
  }

  async function registerTools() {
    const resolved = await loadDefineTool()
    if (resolved.defineTool === null) log(`tool helper unreachable, using plain definitions: ${resolved.error}`)

    const refreshProperty = {
      dsl: { refresh: { type: 'boolean', description: 'Re-probe the interpreter and query the release channel instead of reporting the snapshot.' } },
      jsonSchema: {
        type: 'object',
        properties: { refresh: { type: 'boolean', description: 'Re-probe the interpreter and query the release channel instead of reporting the snapshot.' } },
        required: [],
        additionalProperties: false,
      },
    }

    const specs = [
      {
        name: 'windows_mcp_status',
        description:
          "Report the Windows desktop automation engine: detected Python, engine mode/version/path, MCP registration, the newest upstream release, and the last automatic upgrade. Call it when desktop tools are missing or after changing this plugin's settings.",
        dsl: refreshProperty.dsl,
        jsonSchema: refreshProperty.jsonSchema,
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        async execute(args) {
          if (args !== null && typeof args === 'object' && args.refresh === true) {
            await refreshLocal()
            await runCheck()
            persistDetect()
          }
          return renderStatus(currentStatus())
        },
      },
      {
        name: 'windows_mcp_setup',
        description:
          'Create the managed Python virtual environment and install the pinned Windows-MCP engine, then register the MCP server. Only needed when windows_mcp_status reports no engine.',
        dsl: { force: { type: 'boolean', description: 'Reinstall even when an attached or managed engine already exists.' } },
        jsonSchema: {
          type: 'object',
          properties: { force: { type: 'boolean', description: 'Reinstall even when an attached or managed engine already exists.' } },
          required: [],
          additionalProperties: false,
        },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        async execute(args) {
          await refreshLocal()
          const force = args !== null && typeof args === 'object' && args.force === true
          if (runtime.engine.mode !== 'none' && !force) return renderStatus(currentStatus())
          const provisioned = await provision('windows_mcp_setup')
          if (provisioned && runtime.registration.registered !== true) registerEngine()
          return renderStatus(currentStatus())
        },
      },
      {
        name: 'windows_mcp_update',
        description:
          'Track the upstream Windows-MCP release: check for a newer version, install it with verification and automatic rollback, or return to the recorded previous version.',
        dsl: {
          action: { type: 'string', required: true, description: 'check: query the release channel. apply: install the newest (or the given) release. rollback: return to the previous version.' },
          version: { type: 'string', description: 'Exact version to install with apply, for example 0.9.0. Defaults to the newest release.' },
        },
        jsonSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['check', 'apply', 'rollback'], description: 'check: query the release channel. apply: install the newest (or the given) release. rollback: return to the previous version.' },
            version: { type: 'string', description: 'Exact version to install with apply, for example 0.9.0. Defaults to the newest release.' },
          },
          required: ['action'],
          additionalProperties: false,
        },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        async execute(args) {
          const action = args !== null && typeof args === 'object' && typeof args.action === 'string' ? args.action : ''
          await refreshLocal()
          if (action === 'check') {
            await runCheck()
            persistDetect()
            return renderStatus(currentStatus())
          }
          if (action === 'rollback') {
            const result = await rollback(updateContext)
            runtime.engine = resolveEngine(config)
            persistDetect()
            log(`rollback: ${result.ok ? 'ok' : 'failed'} ${result.reason}`)
            return `${result.ok ? 'rolled back' : 'rollback failed'}: ${result.from ?? '?'} -> ${result.to ?? '?'}${result.reason === '' ? '' : `\n${result.reason}`}\n\n${renderStatus(currentStatus())}`
          }
          if (action === 'apply') {
            const requested = args !== null && typeof args === 'object' && typeof args.version === 'string' && args.version !== '' ? args.version : null
            const check = await runCheck()
            const target = requested ?? check.latest
            if (target === null) return `no release available to install: ${check.error || 'release channel unreachable'}\n\n${renderStatus(currentStatus())}`
            const result = await upgrade(updateContext, target)
            await refreshLocal()
            persistDetect()
            log(`manual update ${result.result}: ${result.reason || 'ok'}`)
            return `update ${result.result}: ${result.from ?? '?'} -> ${result.to}${result.reason === '' ? '' : `\n${result.reason}`}\n\n${renderStatus(currentStatus())}`
          }
          return 'usage: windows_mcp_update { action: "check" | "apply" | "rollback", version?: "0.9.0" }'
        },
      },
    ]

    const names = []
    for (const spec of specs) {
      try {
        ctx.tools.register(makeTool(resolved, spec))
        names.push(spec.name)
      } catch (error) {
        runtime.tools = { registered: names.length > 0, names, reason: `${spec.name} failed: ${errorText(error)}`, via: resolved.via }
        log(`tool registration failed for ${spec.name}: ${errorText(error)}`)
        return
      }
    }
    runtime.tools = { registered: true, names, reason: '', via: resolved.via }
    log(`tools registered via ${resolved.via}: ${names.join(', ')}`)
  }

  // ------------------------------------------------------------- activation

  await refreshLocal()
  log(
    `python: ${runtime.python === null ? 'not found' : `${runtime.python.version} at ${runtime.python.path}`}; ` +
      `engine: ${runtime.engine.mode}${runtime.engine.version === null ? '' : ` ${runtime.engine.version}`}; payload: ${describePayload(payload)}`,
  )

  ctx.effect(() => () => unregisterEngine())

  if (config.autoSetup && runtime.engine.mode === 'none') {
    const provisioned = await provision(`init.mode=${config.initMode}`)
    if (!provisioned) log('automatic provisioning failed; windows_mcp_status explains why')
  }

  if (runtime.engine.mode !== 'none') registerEngine()

  await registerTools()

  persistDetect()

  if (config.update.auto === true || config.update.applyOnStart === true) {
    ctx.effect(() => {
      const timer = setTimeout(() => {
        void maybeAutoUpdate().catch((error) => log(`update check failed: ${errorText(error)}`))
      }, STARTUP_CHECK_DELAY_MS)
      if (typeof timer.unref === 'function') timer.unref()
      return () => clearTimeout(timer)
    })
  }
}
