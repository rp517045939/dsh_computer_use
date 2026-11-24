/**
 * Environment detection: which Python 3.14 can host the engine, whether that
 * interpreter has pip, and what the release channel currently offers.
 *
 * Detection never installs anything. It only reports, so `init.mode=detect` and
 * `init.mode=advise` stay side-effect free.
 */
import { join } from 'node:path'
import { run, fileExists, isStoreAlias, firstLine } from './exec.js'

const PROBE_SCRIPT = 'import sys;print(sys.version.split()[0]);print(sys.executable)'

function atLeast(version, minimum) {
  const parts = String(version).split('.').map((item) => Number.parseInt(item, 10))
  if (parts.length < 2 || parts.some((item) => !Number.isFinite(item))) return false
  if (parts[0] !== minimum[0]) return parts[0] > minimum[0]
  return parts[1] >= minimum[1]
}

function commonPythonPaths() {
  const paths = []
  const localAppData = process.env.LOCALAPPDATA
  if (typeof localAppData === 'string' && localAppData !== '') {
    paths.push(join(localAppData, 'Programs', 'Python', 'Python314', 'python.exe'))
  }
  paths.push('C:\\Python314\\python.exe')
  const programFiles = process.env.ProgramFiles
  if (typeof programFiles === 'string' && programFiles !== '') {
    paths.push(join(programFiles, 'Python314', 'python.exe'))
  }
  return paths
}

/**
 * Ordered interpreter candidates: explicit config first, then a payload runtime the
 * plugin ships, then launcher, PATH, and well-known installs.
 * @param {object} config
 * @param {{ command: string, args: string[], source: string }[]} [extra] - highest-priority additions after `python.path`.
 */
export function pythonCandidates(config, extra = []) {
  const candidates = []
  if (config.pythonPath !== '') candidates.push({ command: config.pythonPath, args: [], source: 'python.path' })
  candidates.push(...extra)
  candidates.push({ command: 'py', args: ['-3.14'], source: 'py launcher (-3.14)' })
  candidates.push({ command: 'py', args: ['-3'], source: 'py launcher (-3)' })
  candidates.push({ command: 'python', args: [], source: 'PATH python' })
  for (const path of commonPythonPaths()) {
    if (fileExists(path)) candidates.push({ command: path, args: [], source: 'well-known path' })
  }
  const seen = new Set()
  return candidates.filter((candidate) => {
    const key = `${candidate.command}\u0000${candidate.args.join(' ')}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

async function probeInterpreter(candidate, minimum) {
  const result = await run(candidate.command, [...candidate.args, '-c', PROBE_SCRIPT], { timeoutMs: 8000 })
  if (!result.ok) {
    return {
      ok: false,
      source: candidate.source,
      command: candidate.command,
      reason: result.timedOut ? 'timed out' : firstLine(result) || result.error || `exit ${result.code}`,
    }
  }
  const lines = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
  const version = lines[0] ?? ''
  const executable = lines[1] ?? candidate.command
  if (version === '') {
    return { ok: false, source: candidate.source, command: candidate.command, reason: 'no version on stdout' }
  }
  if (isStoreAlias(executable) || isStoreAlias(candidate.command)) {
    return { ok: false, source: candidate.source, command: executable, version, reason: 'Microsoft Store alias, not a real interpreter' }
  }
  if (!atLeast(version, minimum)) {
    return { ok: false, source: candidate.source, command: executable, version, reason: `needs Python >= ${minimum.join('.')}` }
  }
  return { ok: true, source: candidate.source, path: executable, version }
}

/**
 * Find a usable interpreter.
 * @returns {Promise<{ ok: boolean, python: object|null, rejected: object[], minimum: number[] }>}
 */
export async function detectPython(config, extra = []) {
  const rejected = []
  for (const candidate of pythonCandidates(config, extra)) {
    const probe = await probeInterpreter(candidate, config.minVersion)
    if (probe.ok) return { ok: true, python: probe, rejected, minimum: config.minVersion }
    rejected.push(probe)
  }
  return { ok: false, python: null, rejected, minimum: config.minVersion }
}

/** `winmcp` keeps its own engine only when nothing was attached. */
export async function detectPip(pythonPath) {
  const result = await run(pythonPath, ['-m', 'pip', '--version'], { timeoutMs: 15000 })
  if (!result.ok) {
    return { ok: false, reason: result.timedOut ? 'timed out' : firstLine(result) || result.error || 'pip unavailable' }
  }
  return { ok: true, version: firstLine(result) }
}
