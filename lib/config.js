/**
 * Configuration normalization and path derivation for the Windows-MCP plugin.
 * Kept dependency-free: the bundle declares no runtime dependencies.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_EXCLUDE = ['PowerShell', 'Registry', 'FileSystem', 'Process']

const INIT_MODES = ['detect', 'advise', 'setup', 'auto']

/** Absolute DSH home; the engine lives below it unless configured elsewhere. */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

function text(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

function count(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function list(value, fallback) {
  if (!Array.isArray(value)) return fallback
  const items = value.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
  return items.length > 0 ? items : fallback
}

function versionParts(value) {
  const match = /^(\d+)\.(\d+)/.exec(String(value))
  if (match === null) return null
  return [Number(match[1]), Number(match[2])]
}

/**
 * @param {Record<string, unknown>} raw - the Loader row's `config` value.
 * @returns normalized config with every default applied.
 */
export function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const init = source.init !== null && typeof source.init === 'object' ? source.init : {}
  const engine = source.engine !== null && typeof source.engine === 'object' ? source.engine : {}
  const python = source.python !== null && typeof source.python === 'object' ? source.python : {}
  const tools = source.tools !== null && typeof source.tools === 'object' ? source.tools : {}
  const server = source.server !== null && typeof source.server === 'object' ? source.server : {}
  const env = source.env !== null && typeof source.env === 'object' ? source.env : {}
  const update = source.update !== null && typeof source.update === 'object' ? source.update : {}
  const payload = source.payload !== null && typeof source.payload === 'object' ? source.payload : {}

  const mode = INIT_MODES.includes(init.mode) ? init.mode : 'advise'
  const minVersion = versionParts(python.minVersion) ?? [3, 14]

  const normalizedEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') normalizedEnv[key] = value
  }

  const engineDir = text(engine.dir, join(dshHome(), 'windows-mcp'))

  return {
    serverName: text(source.serverName, 'windows'),
    initMode: mode,
    autoSetup: mode === 'setup' || mode === 'auto',
    allowDownload: mode === 'auto',
    engineDir,
    venvDir: join(engineDir, 'venv'),
    runtimeDir: join(engineDir, 'runtime'),
    attachVenv: text(engine.attachVenv, ''),
    pythonPath: text(python.path, ''),
    minVersion,
    engineVersion: text(source.engineVersion, ''),
    exclude: list(tools.exclude, DEFAULT_EXCLUDE),
    extraArgs: list(tools.extraArgs, []),
    startupTimeoutMs: count(server.startupTimeoutMs, 60000),
    toolCallTimeoutMs: count(server.toolCallTimeoutMs, 120000),
    update: {
      auto: typeof update.auto === 'boolean' ? update.auto : true,
      debounceHours: count(update.debounceHours, 24),
      maxAttempts: count(update.maxAttempts, 2),
      minFreeDiskMb: count(update.minFreeDiskMb, 1536),
      checkIntervalHours: count(update.checkIntervalHours, 24),
      applyOnStart: typeof update.applyOnStart === 'boolean' ? update.applyOnStart : true,
    },
    payloadDir: text(payload.dir, ''),
    env: {
      ANONYMIZED_TELEMETRY: 'false',
      WINDOWS_MCP_DISABLE_FLASH: '1',
      WINDOWS_MCP_SCREENSHOT_SCALE: '0.5',
      ...normalizedEnv,
    },
  }
}

/** `C:\venv` → `C:\venv\Scripts\windows-mcp.exe` */
export function engineExecutable(venvDir) {
  return join(venvDir, 'Scripts', 'windows-mcp.exe')
}

/** `C:\venv` → `C:\venv\Scripts\python.exe` */
export function venvPython(venvDir) {
  return join(venvDir, 'Scripts', 'python.exe')
}
