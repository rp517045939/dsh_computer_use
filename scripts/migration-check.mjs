/**
 * Read-only migration check: who owns the `windows` tool namespace right now?
 *
 *   node scripts/migration-check.mjs [--profile desktop]
 *
 * It never writes. It reports the static MCP rows in the profile, whether this
 * bundle is installed, and the exact edits migration needs.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageDir = resolve(here, '..')

function argument(name, fallback) {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback
}

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const profile = argument('--profile', process.env.DSH_PROFILE || 'desktop')
const profileDir = process.env.DSH_PROFILE_DIR || join(dshHome, 'profiles', profile)

console.log(`profile    ${profile}`)
console.log(`directory  ${profileDir}`)

if (!existsSync(profileDir)) {
  console.log('profile directory not found; nothing to check')
  process.exit(0)
}

const manifestPath = join(profileDir, 'package.json')
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {}
const bundles = manifest?.dsh?.profile?.bundles ?? []
console.log(`bundles    ${bundles.join(', ') || '(none)'}`)

const pluginManifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
const installed = bundles.includes(pluginManifest.name)
console.log(`plugin     ${pluginManifest.name} ${installed ? 'installed' : 'NOT installed'}`)

// Static MCP client rows: find `<serverName: windows>` inside patch files.
const patchFiles = [join(profileDir, 'cordis.patch.yml')]
const staticWindows = []

for (const file of patchFiles) {
  if (!existsSync(file)) continue
  const text = readFileSync(file, 'utf8')
  const blocks = text.split(/\n(?=- )/)
  for (const block of blocks) {
    if (!/dsh-mcp-client/.test(block)) continue
    const name = /serverName:\s*([A-Za-z0-9_-]+)/.exec(block)?.[1]
    const id = /\n\s*- id:\s*([A-Za-z0-9_-]+)/.exec(`\n${block}`)?.[1] ?? /id:\s*([A-Za-z0-9_-]+)/.exec(block)?.[1]
    const disabled = /\ndisabled:\s*true/.test(`\n${block}`)
    staticWindows.push({ file, id: id ?? '(inline)', name: name ?? '(none)', disabled })
  }
}

const bundlePatch = join(packageDir, 'cordis.patch.yml')
const configuredName = existsSync(bundlePatch)
  ? /serverName:\s*([A-Za-z0-9_-]+)/.exec(readFileSync(bundlePatch, 'utf8'))?.[1] ?? '(none)'
  : '(none)'

console.log('')
console.log('static MCP client rows in the profile:')
if (staticWindows.length === 0) console.log('  (none found by this heuristic; inspect the profile patch manually)')
for (const row of staticWindows) {
  console.log(`  - id=${row.id} serverName=${row.name}${row.disabled ? ' (disabled)' : ''}  <- ${row.file}`)
}

const activeWindows = staticWindows.filter((row) => row.name === 'windows' && !row.disabled)
console.log('')
console.log(`plugin serverName (bundle patch)  ${configuredName}`)

if (activeWindows.length > 0) {
  console.log('')
  console.log('MIGRATION NEEDED: an active static row already owns serverName "windows".')
  if (!installed) {
    console.log(`  0. Install this bundle first (${pluginManifest.name}); it will report the collision until step 1.`)
  }
  console.log('  1. Disable that row first (Plugins, or a profile patch row with disabled: true).')
  console.log(`  2. Keep this bundle's serverName at "windows" (currently "${configuredName}").`)
  console.log('  3. Reload DSH, then run windows_mcp_status: server.registered must be true.')
  process.exit(1)
}

if (configuredName !== 'windows') {
  console.log('')
  console.log(`No collision. To finish migration, set serverName to "windows" (currently "${configuredName}").`)
  process.exit(0)
}

console.log('')
console.log('Clean: the plugin owns serverName "windows" and no static row competes for it.')
