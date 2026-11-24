/**
 * Local smoke test for the plugin's detection layer.
 * Runs without DSH: pure module-level checks of config, engine resolution, and probes.
 *   node test/smoke.mjs
 */
import { normalizeConfig, engineExecutable, venvPython } from '../lib/config.js'
import { resolveEngine, engineArgs } from '../lib/engine.js'
import { detectPython, detectPip } from '../lib/detect.js'
import { fetchLatestRelease } from '../lib/upstream.js'

const raw = {
  serverName: 'winmcp',
  init: { mode: 'advise' },
  engineVersion: '0.9.0',
}
const config = normalizeConfig(raw)

console.log('--- config ---')
console.log('serverName        ', config.serverName)
console.log('initMode          ', config.initMode)
console.log('engineDir         ', config.engineDir)
console.log('venvDir           ', config.venvDir)
console.log('minVersion        ', config.minVersion.join('.'))
console.log('exclude           ', config.exclude.join(','))
console.log('engineExecutable  ', engineExecutable(config.venvDir))
console.log('venvPython        ', venvPython(config.venvDir))

console.log('\n--- engine (managed, not provisioned) ---')
const resolved = resolveEngine(config)
console.log(JSON.stringify(resolved, null, 2))
console.log('args              ', JSON.stringify(engineArgs(config)))

console.log('\n--- engine (attached to the legacy venv) ---')
const attached = normalizeConfig({ engine: { attachVenv: 'D:\\CODE\\something\\Windows_MCP\\.venv' } })
console.log(JSON.stringify(resolveEngine(attached), null, 2))

console.log('\n--- python detection ---')
const detection = await detectPython(config)
console.log('ok     ', detection.ok)
console.log('found  ', detection.python)
console.log('rejected', detection.rejected)

if (detection.python !== null) {
  console.log('\n--- pip ---')
  console.log(await detectPip(detection.python.path))
}

console.log('\n--- release channel ---')
console.log(await fetchLatestRelease())
