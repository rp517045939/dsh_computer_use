/**
 * Release-channel updater: check, upgrade, roll back.
 *
 * Only the release channel is tracked. Every promotion is verified before the live
 * instance is touched: the wheel digest is checked, the new engine must answer a
 * handshake, and its tool surface must still honour the exclusion policy. Any
 * failure puts the previous version back and records why.
 */
import { statfs } from 'node:fs/promises'
import { engineArgs } from './engine.js'
import { compareVersions, fetchLatestRelease, fetchVersionArtifacts, isVersionLike, verifyReleaseTag } from './upstream.js'
import { describeSurface, evaluateToolSurface } from './policy.js'

const DEFAULT_DEBOUNCE_HOURS = 24
const DEFAULT_MAX_ATTEMPTS = 2
const DEFAULT_MIN_FREE_MB = 1536

function hoursSince(isoTimestamp, now) {
  if (typeof isoTimestamp !== 'string') return Number.POSITIVE_INFINITY
  const at = Date.parse(isoTimestamp)
  if (!Number.isFinite(at)) return Number.POSITIVE_INFINITY
  return (now - at) / 3600000
}

async function freeMegabytes(path) {
  try {
    const stats = await statfs(path)
    return Math.floor((stats.bsize * stats.bavail) / (1024 * 1024))
  } catch {
    return null
  }
}

/**
 * Query the release channel and compare with what is installed.
 * @returns {Promise<{ ok: boolean, installed: string|null, latest: string|null, outdated: boolean, yanked: boolean, checkedAt: string, error: string }>}
 */
export async function checkForUpdate(context) {
  const { config, ops, log } = context
  const installed = ops.installedVersion()
  const response = await fetchLatestRelease()
  const checkedAt = new Date().toISOString()
  if (!response.ok) {
    log?.(`release check failed: ${response.error}`)
    return { ok: false, installed, latest: null, outdated: false, yanked: false, checkedAt, error: response.error }
  }
  const outdated = installed !== null && isVersionLike(installed) && compareVersions(response.version, installed) > 0
  log?.(`release check: installed ${installed ?? '(unknown)'}, latest ${response.version}${outdated ? ' (update available)' : ''}`)
  return { ok: true, installed, latest: response.version, outdated, yanked: response.yanked === true, checkedAt, error: '' }
}

/**
 * Decide whether an unattended upgrade may run now. Every refusal names its reason
 * so the status surface can explain why nothing happened.
 * @returns {{ allowed: boolean, reason: string }}
 */
export function autoApplyGate({ config, state, check, now = Date.now() }) {
  const update = config.update
  if (!update.auto) return { allowed: false, reason: 'automatic updates are disabled' }
  if (check.ok !== true) return { allowed: false, reason: `release channel unavailable: ${check.error}` }
  if (check.yanked) return { allowed: false, reason: 'that release is yanked upstream' }
  if (!check.outdated) return { allowed: false, reason: 'already on the newest release' }
  if (state?.upgrading === true) return { allowed: false, reason: 'another upgrade is in progress' }

  const attempts = Array.isArray(state?.attempts) ? state.attempts : []
  const failed = attempts.filter((item) => item?.version === check.latest && item?.result !== 'ok').length
  if (failed >= (update.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)) {
    return { allowed: false, reason: `${check.latest} already failed ${failed} times; waiting for a human` }
  }

  const debounceHours = update.debounceHours ?? DEFAULT_DEBOUNCE_HOURS
  const lastUpgradeAt = state?.lastUpgrade?.at
  if (hoursSince(lastUpgradeAt, now) < debounceHours) {
    return { allowed: false, reason: `last upgrade was less than ${debounceHours} h ago` }
  }
  return { allowed: true, reason: 'eligible' }
}

async function probeSurfaces(context) {
  const { config, ops } = context
  const engine = ops.currentEngine()
  const base = { command: engine.command, env: config.env, cwd: config.engineDir }
  const augmented = await ops.probe({ ...base, args: engineArgs(config) })
  if (!augmented.ok) return { ok: false, error: `augmented probe failed: ${augmented.error}` }
  const raw = await ops.probe({ ...base, args: engineArgs(config, { exclude: false }) })
  if (!raw.ok) return { ok: false, error: `raw probe failed: ${raw.error}` }
  return { ok: true, surfaces: { augmented: augmented.tools, raw: raw.tools } }
}

/**
 * Install `targetVersion` and promote it, or put the previous version back.
 * @param {{
 *   config: object,
 *   log: (line: string) => void,
 *   store: { read: () => object, patch: (value: object) => object },
 *   ops: {
 *     installedVersion: () => string|null,
 *     currentEngine: () => object,
 *     pipInstall: (version: string) => Promise<{ ok: boolean, error: string, stderr: string, timedOut?: boolean }>,
 *     probe: (entry: object) => Promise<{ ok: boolean, tools: string[], error: string }>,
 *     restartServer: () => Promise<{ ok: boolean, error: string }>,
 *     serverStatus: () => unknown,
 *   },
 * }} context
 * @returns {Promise<{ ok: boolean, from: string|null, to: string, result: string, reason: string, surface: object|null }>}
 */
export async function upgrade(context, targetVersion) {
  const { config, log, store, ops } = context
  const from = ops.installedVersion()
  const previous = store.read()
  const attemptAt = new Date().toISOString()

  const record = (result, reason, surface = null) => {
    const attempts = Array.isArray(previous.attempts) ? previous.attempts : []
    attempts.push({ version: targetVersion, at: attemptAt, result, reason })
    store.patch({
      upgrading: false,
      attempts: attempts.slice(-20),
      lastUpgrade: { from, to: targetVersion, at: attemptAt, result, reason },
      toolNames: surface !== null && surface.ok === true ? surface.tools : previous.toolNames,
    })
  }

  if (!isVersionLike(targetVersion)) {
    record('failed:invalid', `not a version: ${targetVersion}`)
    return { ok: false, from, to: targetVersion, result: 'failed:invalid', reason: 'target is not a version like 0.9.0', surface: null }
  }
  if (previous.upgrading === true) {
    return { ok: false, from, to: targetVersion, result: 'failed:busy', reason: 'another upgrade is in progress', surface: null }
  }

  const free = await freeMegabytes(config.engineDir)
  if (free !== null && free < (config.update.minFreeDiskMb ?? DEFAULT_MIN_FREE_MB)) {
    record('failed:disk', `only ${free} MB free`)
    return { ok: false, from, to: targetVersion, result: 'failed:disk', reason: `only ${free} MB free`, surface: null }
  }

  store.patch({ upgrading: true })

  const fail = async (result, reason) => {
    record(result, reason)
    if (from !== null && from !== targetVersion) {
      log(`rolling back to ${from}`)
      const back = await ops.pipInstall(from)
      if (back.ok) {
        await ops.restartServer()
        log(`rolled back to ${from}`)
      } else {
        log(`rollback install failed: ${back.error}`)
      }
    }
    return { ok: false, from, to: targetVersion, result, reason, surface: null }
  }

  // 1. Artifact trust: the wheel for this exact version must exist and be digestible.
  const artifacts = await fetchVersionArtifacts(targetVersion)
  if (!artifacts.ok) return fail('failed:artifact', artifacts.error)

  const tag = await verifyReleaseTag(targetVersion)
  if (tag.ok && tag.found === false) {
    log(`warning: ${targetVersion} has no matching release tag upstream; continuing with the PyPI artifact`)
  }

  // 2. Install before touching the live instance.
  log(`installing windows-mcp==${targetVersion} (sha256 ${artifacts.digest.sha256.slice(0, 12)}…)`)
  const install = await ops.pipInstall(targetVersion)
  if (!install.ok) {
    return fail('failed:install', install.timedOut === true ? 'pip install timed out' : install.error || `pip exited ${install.exitCode ?? '?'}`)
  }

  // 3. The new code must answer a handshake and honour the tool policy.
  const probed = await probeSurfaces(context)
  if (!probed.ok) return fail('failed:probe', probed.error)

  const surface = evaluateToolSurface(config, probed.surfaces, previous.toolNames ?? null)
  log(describeSurface(surface))
  if (!surface.ok) return fail('failed:policy', surface.problems.join('; '))

  // 4. Promote: same venv path, so restarting the instance loads the new code.
  const restarted = await ops.restartServer()
  if (!restarted.ok) return fail('failed:restart', restarted.error)

  store.patch({
    upgrading: false,
    installed: targetVersion,
    previous: from,
    toolNames: probed.surfaces.augmented,
    attempts: (Array.isArray(previous.attempts) ? previous.attempts : []).concat([{ version: targetVersion, at: attemptAt, result: 'ok', reason: '' }]).slice(-20),
    lastUpgrade: { from, to: targetVersion, at: attemptAt, result: 'ok', reason: '' },
  })
  log(`upgraded ${from ?? '(unknown)'} -> ${targetVersion}`)
  return { ok: true, from, to: targetVersion, result: 'ok', reason: '', surface }
}

/**
 * Put the recorded previous version back.
 * @returns {Promise<{ ok: boolean, from: string|null, to: string|null, reason: string }>}
 */
export async function rollback(context) {
  const { log, store, ops } = context
  const state = store.read()
  const target = state.previous
  const from = ops.installedVersion()
  if (typeof target !== 'string' || target === '') {
    return { ok: false, from, to: null, reason: 'no previous version recorded' }
  }
  if (target === from) {
    return { ok: true, from, to: target, reason: 'already on the previous version' }
  }
  log(`rolling back ${from ?? '(unknown)'} -> ${target}`)
  const install = await ops.pipInstall(target)
  if (!install.ok) return { ok: false, from, to: target, reason: install.error }
  const restarted = await ops.restartServer()
  if (!restarted.ok) return { ok: false, from, to: target, reason: restarted.error }
  store.patch({
    installed: target,
    previous: from,
    lastUpgrade: { from, to: target, at: new Date().toISOString(), result: 'rolled-back', reason: 'manual rollback' },
    toolNames: null,
  })
  return { ok: true, from, to: target, reason: '' }
}
