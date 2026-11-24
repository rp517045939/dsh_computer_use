/**
 * Build a distributable copy of the plugin.
 *
 *   node scripts/pack.mjs              # dist/dsh-windows-mcp/
 *   node scripts/pack.mjs --zip        # dist/dsh-windows-mcp.zip
 *
 * A payload directory (payload/python, payload/wheelhouse) is copied when present,
 * which turns the same package into an offline installer. Without one the package
 * stays a few kilobytes and provisions from PyPI on first setup.
 *
 * Installing straight from GitHub does not need this script: the repository root is
 * the bundle package, so a git spec installs the same files.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const packageDir = resolve(here, '..')
const distDir = join(packageDir, 'dist')
const target = join(distDir, 'dsh-windows-mcp')
const wantZip = process.argv.includes('--zip')

const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
const entries = ['package.json', 'index.js', 'cordis.patch.yml', 'lib', 'locale', 'docs', 'scripts', 'icon.svg', 'README.md']
const payloadDir = join(packageDir, 'payload')

rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })

for (const entry of entries) {
  const source = join(packageDir, entry)
  if (!existsSync(source)) {
    console.warn(`skip missing ${entry}`)
    continue
  }
  cpSync(source, join(target, entry), { recursive: true })
}

const hasPayload = existsSync(payloadDir)
if (hasPayload) {
  console.log('payload present: copying (this makes the package an offline installer)')
  cpSync(payloadDir, join(target, 'payload'), { recursive: true })
}

console.log(`packed ${manifest.name}@${manifest.version} -> ${target}`)
console.log(`payload: ${hasPayload ? 'included' : 'absent (online install)'}`)

if (wantZip) {
  const archive = `${target}.zip`
  rmSync(archive, { force: true })
  const result = spawnSync('tar', ['-a', '-cf', archive, '-C', distDir, 'dsh-windows-mcp'], { stdio: 'inherit' })
  if (result.status === 0) console.log(`archive -> ${archive}`)
  else console.error('tar failed; the directory copy above is still usable')
}
