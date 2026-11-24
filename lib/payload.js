/**
 * Offline payload support.
 *
 * A machine with no PyPI access gets a `payload/` directory next to the plugin
 * code: a portable interpreter, a wheelhouse, or both. Nothing is downloaded when
 * the payload can satisfy the step, so the same plugin package serves online and
 * offline installs.
 */
import { join } from 'node:path'
import { dirExists, fileExists } from './exec.js'

/**
 * @param {{ payloadDir: string }} config
 * @param {string} packageDir - the directory holding package.json.
 * @returns {{ dir: string, exists: boolean, python: string, wheelhouse: string, wheels: number }}
 */
export function resolvePayload(config, packageDir) {
  const dir = config.payloadDir !== '' ? config.payloadDir : join(packageDir, 'payload')
  const python = join(dir, 'python', 'python.exe')
  const wheelhouse = join(dir, 'wheelhouse')
  return {
    dir,
    exists: dirExists(dir),
    python: fileExists(python) ? python : '',
    wheelhouse: dirExists(wheelhouse) ? wheelhouse : '',
    wheels: 0,
  }
}

/** Human summary for the status surface. */
export function describePayload(payload) {
  if (!payload.exists) return 'absent (online install)'
  const parts = []
  if (payload.python !== '') parts.push(`interpreter ${payload.python}`)
  if (payload.wheelhouse !== '') parts.push(`wheelhouse ${payload.wheelhouse}`)
  return parts.length === 0 ? `present but empty: ${payload.dir}` : parts.join(', ')
}
