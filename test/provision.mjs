/**
 * Run the plugin's own provisioning path (venv + pinned engine install) outside DSH.
 *
 * This is the same code `windows_mcp_setup` calls, so a success here means the
 * plugin will find a managed engine at its default location on its next activation.
 *   node test/provision.mjs
 */
import { normalizeConfig } from '../lib/config.js'
import { createVenv, installEngine, resolveEngine } from '../lib/engine.js'
import { detectPython, detectPip } from '../lib/detect.js'

const config = normalizeConfig({ serverName: 'winmcp', engineVersion: '0.9.0' })
const started = Date.now()
const step = (line) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${line}`)

step(`engineDir ${config.engineDir}`)
step(`venvDir   ${config.venvDir}`)

const detection = await detectPython(config)
if (detection.python === null) {
  console.error('no usable Python:', JSON.stringify(detection.rejected, null, 2))
  process.exit(1)
}
step(`python    ${detection.python.version} at ${detection.python.path}`)

const pip = await detectPip(detection.python.path)
step(`pip       ${pip.ok ? pip.version : `unavailable: ${pip.reason}`}`)
if (!pip.ok) process.exit(1)

step('creating venv...')
const venv = await createVenv(config, detection.python.path)
if (!venv.ok) {
  console.error('venv failed:', venv.error, venv.stderr)
  process.exit(1)
}
step('venv created')

step(`installing windows-mcp==${config.engineVersion} ...`)
const install = await installEngine(config, (line) => step(`  ${line}`))
if (!install.ok) {
  console.error('install failed:', install.error)
  console.error(install.stderr.slice(-2000))
  process.exit(1)
}
step('install finished')

const engine = resolveEngine(config)
step(`resolved  ${JSON.stringify(engine)}`)
if (engine.mode !== 'managed') {
  console.error('engine did not resolve as managed')
  process.exit(1)
}
console.log(`\nOK engine ${engine.version} at ${engine.command}`)
