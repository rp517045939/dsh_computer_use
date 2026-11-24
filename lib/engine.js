/**
 * Engine resolution and provisioning.
 *
 * The engine is the upstream `windows-mcp` Python package. Its install location is
 * deliberate: `<engineDir>\venv` is stable across upgrades, so an upgrade only
 * replaces the contents and a manager restart picks up the new code.
 */
import { mkdirSync } from 'node:fs'
import { engineExecutable, venvPython } from './config.js'
import { fileExists, installedDistributionVersion, run } from './exec.js'

/**
 * Which engine a call would use right now.
 * @returns {{ mode: 'attach'|'managed'|'none', venvDir: string, command: string, version: string|null, reason?: string }}
 */
export function resolveEngine(config) {
  if (config.attachVenv !== '') {
    const command = engineExecutable(config.attachVenv)
    if (fileExists(command)) {
      return {
        mode: 'attach',
        venvDir: config.attachVenv,
        command,
        version: installedDistributionVersion(config.attachVenv, 'windows_mcp'),
      }
    }
  }
  const command = engineExecutable(config.venvDir)
  if (fileExists(command)) {
    return {
      mode: 'managed',
      venvDir: config.venvDir,
      command,
      version: installedDistributionVersion(config.venvDir, 'windows_mcp'),
    }
  }
  const reason = config.attachVenv !== ''
    ? `attachVenv has no windows-mcp.exe: ${config.attachVenv}`
    : `no engine at ${config.venvDir}`
  return { mode: 'none', venvDir: config.venvDir, command: '', version: null, reason }
}

/**
 * Arguments shared by every engine instance.
 * @param {{ exclude: string[], extraArgs: string[] }} config
 * @param {{ exclude?: boolean }} [options] - `exclude: false` asks upstream for its
 *   complete surface, which the policy review needs for comparison.
 */
export function engineArgs(config, options = {}) {
  const args = ['serve', '--transport', 'stdio']
  if (options.exclude !== false && config.exclude.length > 0) args.push('--exclude-tools', config.exclude.join(','))
  args.push(...config.extraArgs)
  return args
}

/** The exact stdio entry the MCP manager registers. */
export function registerEntry(config, engine) {
  return {
    transport: 'stdio',
    command: engine.command,
    args: engineArgs(config),
    env: config.env,
    cwd: config.engineDir,
    startupTimeoutMs: config.startupTimeoutMs,
    toolCallTimeoutMs: config.toolCallTimeoutMs,
  }
}

export function ensureEngineDir(config) {
  mkdirSync(config.engineDir, { recursive: true })
  return config.engineDir
}

/**
 * Create the managed venv from a detected interpreter.
 * @returns {Promise<{ ok: boolean, stdout: string, stderr: string, error: string }>}
 */
export async function createVenv(config, pythonPath) {
  ensureEngineDir(config)
  const result = await run(pythonPath, ['-m', 'venv', config.venvDir], { timeoutMs: 180000 })
  return result
}

/**
 * Install one engine version into the managed venv.
 *
 * With a wheelhouse (payload directory), the install is offline: pip is told to
 * resolve only from local wheels, which is what a machine without PyPI access needs.
 * Without one it goes to the index as usual.
 * @param {{ venvDir: string, engineVersion: string }} config
 * @param {(line: string) => void} [log]
 * @param {{ version?: string, wheelhouse?: string }} [options]
 */
export async function installEngine(config, log, options = {}) {
  const python = venvPython(config.venvDir)
  if (!fileExists(python)) {
    return { ok: false, stdout: '', stderr: '', error: `venv python missing: ${python}`, timedOut: false, exitCode: 1 }
  }
  const version = typeof options.version === 'string' && options.version !== '' ? options.version : config.engineVersion
  const spec = version === '' ? 'windows-mcp' : `windows-mcp==${version}`
  const wheelhouse = typeof options.wheelhouse === 'string' ? options.wheelhouse : ''
  const args = ['-m', 'pip', 'install', '--no-input', '--disable-pip-version-check']
  if (wheelhouse !== '') args.push('--no-index', '--find-links', wheelhouse)
  args.push(spec)
  log?.(`pip install ${spec}${wheelhouse === '' ? '' : ` (offline from ${wheelhouse})`}`)
  const result = await run(python, args, { timeoutMs: 900000 })
  return { ...result, exitCode: result.code }
}

/** Executable + args for one engine install, used by diagnostics. */
export function engineCommand(config, engine) {
  return [engine.command, ...engineArgs(config)].join(' ')
}
