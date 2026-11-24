/**
 * Pure-logic self-check: no desktop, no network, no installs.
 *
 *   node test/logic.mjs
 *
 * Covers the two places where a silent mistake costs the most: the release
 * comparison that decides whether to upgrade, and the tool-surface policy that
 * decides whether a version may be promoted at all.
 */
import assert from 'node:assert/strict'
import { compareVersions, isVersionLike } from '../lib/upstream.js'
import { autoApplyGate } from '../lib/update.js'
import { evaluateToolSurface } from '../lib/policy.js'
import { assessHealth, buildDetectState } from '../lib/snapshot.js'

const cases = []
function check(name, fn) {
  cases.push({ name, fn })
}

const config = {
  exclude: ['PowerShell', 'Registry', 'FileSystem', 'Process'],
  update: { auto: true, debounceHours: 24, maxAttempts: 2, minFreeDiskMb: 1536 },
}

// ---------------------------------------------------------------- versions

check('compareVersions orders releases', () => {
  assert.ok(compareVersions('0.9.0', '0.8.8') > 0)
  assert.ok(compareVersions('0.8.8', '0.9.0') < 0)
  assert.equal(compareVersions('0.9.0', '0.9.0'), 0)
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0)
  assert.ok(compareVersions('1.0.0', '0.99.0') > 0)
})

check('isVersionLike rejects ranges and junk', () => {
  assert.equal(isVersionLike('0.9.0'), true)
  assert.equal(isVersionLike('0.9'), false)
  assert.equal(isVersionLike('>=0.9.0'), false)
  assert.equal(isVersionLike(''), false)
  assert.equal(isVersionLike(undefined), false)
})

// ------------------------------------------------------------------- gates

function gate(overrides) {
  return autoApplyGate({
    config,
    state: { upgrading: false, attempts: [], lastUpgrade: null },
    check: { ok: true, installed: '0.8.8', latest: '0.9.0', outdated: true, yanked: false, error: '' },
    now: Date.parse('2026-11-24T10:00:00Z'),
    ...overrides,
  })
}

check('gate allows a fresh, newer, non-yanked release', () => {
  assert.equal(gate({}).allowed, true)
})

check('gate refuses when auto updates are off', () => {
  const result = gate({ config: { ...config, update: { ...config.update, auto: false } } })
  assert.equal(result.allowed, false)
  assert.match(result.reason, /disabled/)
})

check('gate refuses when already current', () => {
  const result = gate({ check: { ok: true, installed: '0.9.0', latest: '0.9.0', outdated: false, yanked: false, error: '' } })
  assert.equal(result.allowed, false)
  assert.match(result.reason, /newest/)
})

check('gate refuses a yanked release', () => {
  const result = gate({ check: { ok: true, installed: '0.8.8', latest: '0.9.0', outdated: true, yanked: true, error: '' } })
  assert.equal(result.allowed, false)
  assert.match(result.reason, /yanked/)
})

check('gate refuses while another upgrade runs', () => {
  const result = gate({ state: { upgrading: true, attempts: [], lastUpgrade: null } })
  assert.equal(result.allowed, false)
  assert.match(result.reason, /in progress/)
})

check('gate refuses after two failures of the same version', () => {
  const attempts = [
    { version: '0.9.0', result: 'failed:policy' },
    { version: '0.9.0', result: 'failed:probe' },
  ]
  const result = gate({ state: { upgrading: false, attempts, lastUpgrade: null } })
  assert.equal(result.allowed, false)
  assert.match(result.reason, /failed 2 times/)
})

check('gate refuses inside the debounce window', () => {
  const result = gate({ state: { upgrading: false, attempts: [], lastUpgrade: { at: '2026-11-24T08:00:00Z', result: 'ok' } } })
  assert.equal(result.allowed, false)
  assert.match(result.reason, /less than 24 h/)
})

check('gate allows once the debounce window passed', () => {
  const result = gate({ state: { upgrading: false, attempts: [], lastUpgrade: { at: '2026-11-22T08:00:00Z', result: 'ok' } } })
  assert.equal(result.allowed, true)
})

// ------------------------------------------------------------------ policy

const healthyRaw = ['ControlStatus', 'App', 'DisplayInventory', 'Snapshot', 'Screenshot', 'Click', 'Type', 'PowerShell', 'Registry', 'FileSystem', 'Process']
const healthyAugmented = healthyRaw.filter((name) => !config.exclude.includes(name))

check('policy accepts a surface whose exclusions still apply', () => {
  const result = evaluateToolSurface(config, { augmented: healthyAugmented, raw: healthyRaw }, healthyAugmented)
  assert.equal(result.ok, true, result.problems.join('; '))
  assert.equal(result.excluded.length, 4)
})

check('policy rejects a renamed exclusion (the silent-failure case)', () => {
  const raw = healthyRaw.map((name) => (name === 'PowerShell' ? 'Shell' : name))
  const augmented = raw.filter((name) => !config.exclude.includes(name))
  const result = evaluateToolSurface(config, { augmented, raw }, healthyAugmented)
  assert.equal(result.ok, false)
  assert.ok(result.problems.some((problem) => problem.includes('PowerShell')))
})

check('policy rejects when the exclusion flag removes nothing', () => {
  const result = evaluateToolSurface(config, { augmented: healthyRaw, raw: healthyRaw }, healthyAugmented)
  assert.equal(result.ok, false)
})

check('policy flags a suspicious new tool', () => {
  const raw = [...healthyRaw, 'RunCommand']
  const augmented = raw.filter((name) => !config.exclude.includes(name))
  const result = evaluateToolSurface(config, { augmented, raw }, healthyAugmented)
  assert.equal(result.ok, false)
  assert.ok(result.problems.some((problem) => problem.includes('RunCommand')))
})

check('policy tolerates a benign new tool and reports the diff', () => {
  const raw = [...healthyRaw, 'WindowList']
  const augmented = raw.filter((name) => !config.exclude.includes(name))
  const result = evaluateToolSurface(config, { augmented, raw }, healthyAugmented)
  assert.equal(result.ok, true, result.problems.join('; '))
  assert.deepEqual(result.added, ['WindowList'])
  assert.deepEqual(result.removed, [])
})

check('policy reports tools that disappeared', () => {
  const raw = healthyRaw.filter((name) => name !== 'Snapshot')
  const augmented = raw.filter((name) => !config.exclude.includes(name))
  const result = evaluateToolSurface(config, { augmented, raw }, healthyAugmented)
  assert.equal(result.ok, true, result.problems.join('; '))
  assert.deepEqual(result.removed, ['Snapshot'])
})

// ------------------------------------------------------------------ health
// Regression: state.json kept the activation-time snapshot, so after
// windows_mcp_setup it still read `engine: none` next to `installed: 0.9.0`.

const python = { version: '3.14.0', path: 'C:\\Python314\\python.exe', source: 'py launcher (-3.14)' }
const pipOk = { ok: true, version: 'pip 25.2' }
const engineNone = { mode: 'none', version: null, venvDir: 'C:\\x\\venv' }
const engineManaged = { mode: 'managed', version: '0.9.0', venvDir: 'C:\\x\\venv' }
const unregistered = { registered: false, reason: 'not attempted yet', command: '' }
const registered = { registered: true, reason: '', command: 'C:\\x\\venv\\Scripts\\windows-mcp.exe serve' }

check('health is blocked without an interpreter', () => {
  assert.equal(assessHealth({ python: null, pip: null, engine: engineNone, registration: unregistered }), 'blocked')
})

check('health is actionable when the engine is missing', () => {
  assert.equal(assessHealth({ python, pip: pipOk, engine: engineNone, registration: unregistered }), 'actionable')
})

check('health is actionable when registration was refused', () => {
  assert.equal(assessHealth({ python, pip: pipOk, engine: engineManaged, registration: unregistered }), 'actionable')
})

check('health is ready when an engine is registered', () => {
  assert.equal(assessHealth({ python, pip: pipOk, engine: engineManaged, registration: registered }), 'ready')
})

check('snapshot after setup reports the managed engine, not the activation state', () => {
  const stale = {
    lastDetectAt: '2026-11-24T02:04:19.531Z',
    installed: '0.8.8',
    detect: { python: null, engine: { mode: 'none', version: null }, registration: unregistered },
  }
  const snapshot = buildDetectState({
    python,
    pythonRejected: [],
    pip: pipOk,
    engine: engineManaged,
    registration: registered,
    tools: { registered: true, names: ['windows_mcp_status'] },
    payload: { dir: 'C:\\p', exists: false, wheelhouse: '', python: '' },
    now: '2026-11-24T03:00:00.000Z',
  })
  const merged = { ...stale, ...snapshot, installed: '0.9.0' }
  assert.equal(merged.detect.engine.mode, 'managed')
  assert.equal(merged.detect.engine.version, '0.9.0')
  assert.equal(merged.detect.registration.registered, true)
  assert.equal(merged.health, 'ready')
  assert.equal(merged.lastDetectAt, '2026-11-24T03:00:00.000Z')
})

check('snapshot keeps the rejected-interpreter list bounded', () => {
  const rejected = Array.from({ length: 20 }, (_, index) => ({ command: `py${index}`, reason: 'too old' }))
  const snapshot = buildDetectState({
    python: null,
    pythonRejected: rejected,
    pip: null,
    engine: engineNone,
    registration: unregistered,
    tools: { registered: false, names: [] },
    payload: null,
  })
  assert.equal(snapshot.detect.pythonRejected.length, 8)
  assert.equal(snapshot.health, 'blocked')
})

// --------------------------------------------------------------------- run

let failed = 0
for (const item of cases) {
  try {
    item.fn()
    console.log(`ok   ${item.name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${item.name}\n     ${error.message.split('\n')[0]}`)
  }
}
console.log(`\n${cases.length - failed}/${cases.length} checks passed`)
process.exitCode = failed === 0 ? 0 : 1
