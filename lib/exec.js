/**
 * Small child-process and filesystem helpers.
 *
 * Every external command is bounded: a hung Python or pip must never stall plugin
 * activation or a tool call without a diagnostic.
 */
import { execFile } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Run a command to completion and always resolve.
 * @param {string} command
 * @param {string[]} args
 * @param {{ timeoutMs?: number, env?: NodeJS.ProcessEnv, cwd?: string, maxBuffer?: number }} [options]
 * @returns {Promise<{ ok: boolean, code: number|string|null, timedOut: boolean, stdout: string, stderr: string, error: string }>}
 */
export function run(command, args, options = {}) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    try {
      const child = execFile(
        command,
        args,
        {
          windowsHide: true,
          timeout: options.timeoutMs ?? 15000,
          maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
          encoding: 'utf8',
          env: options.env ?? process.env,
          cwd: options.cwd,
        },
        (error, stdout, stderr) => {
          const timedOut = Boolean(error && (error.killed === true || error.signal === 'SIGTERM'))
          finish({
            ok: !error,
            code: error ? (error.code ?? 1) : 0,
            timedOut,
            stdout: typeof stdout === 'string' ? stdout : '',
            stderr: typeof stderr === 'string' ? stderr : '',
            error: error ? String(error.message ?? error) : '',
          })
        },
      )
      child.on('error', (error) => {
        finish({ ok: false, code: 1, timedOut: false, stdout: '', stderr: '', error: String(error.message ?? error) })
      })
    } catch (error) {
      finish({ ok: false, code: 1, timedOut: false, stdout: '', stderr: '', error: String(error?.message ?? error) })
    }
  })
}

export function fileExists(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

export function dirExists(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Version of an installed distribution, read from its `.dist-info` directory.
 * Avoids executing the engine just to ask its version.
 * @param {string} venvDir
 * @param {string} distribution - e.g. `windows_mcp`
 * @returns {string|null}
 */
export function installedDistributionVersion(venvDir, distribution) {
  const sitePackages = join(venvDir, 'Lib', 'site-packages')
  if (!dirExists(sitePackages)) return null
  try {
    const prefix = `${distribution}-`
    for (const entry of readdirSync(sitePackages)) {
      if (!entry.startsWith(prefix) || !entry.endsWith('.dist-info')) continue
      return entry.slice(prefix.length, entry.length - '.dist-info'.length)
    }
  } catch {
    return null
  }
  return null
}

/** First line of a command's stdout, trimmed; empty when it failed. */
export function firstLine(result) {
  if (!result || typeof result.stdout !== 'string') return ''
  const line = result.stdout.split(/\r?\n/).find((item) => item.trim() !== '')
  return line === undefined ? '' : line.trim()
}

/** True when the path is the Windows Store `python.exe` App Execution Alias. */
export function isStoreAlias(path) {
  return /\\WindowsApps\\/i.test(path)
}

export { join }
