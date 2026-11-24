/**
 * Direct stdio handshake with the managed engine, independent of DSH.
 *
 * Proves the provisioned executable really speaks MCP and shows the exact tool
 * surface the `--exclude-tools` policy leaves visible (the input for the M2 drift check).
 *   node test/engine-handshake.mjs
 */
import { spawn } from 'node:child_process'
import { normalizeConfig } from '../lib/config.js'
import { engineArgs, resolveEngine } from '../lib/engine.js'

const config = normalizeConfig({ engineVersion: '0.9.0' })
const engine = resolveEngine(config)
if (engine.mode === 'none') {
  console.error('no engine to handshake with')
  process.exit(1)
}

console.log(`engine ${engine.version} at ${engine.command}`)
const args = engineArgs(config)
console.log(`args   ${JSON.stringify(args)}`)

const child = spawn(engine.command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...config.env } })

let buffered = ''
const pending = new Map()
let nextId = 1

function send(method, params) {
  const id = nextId++
  const message = { jsonrpc: '2.0', id, method, params }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`${method} timed out`))
    }, 20000)
    pending.set(id, { resolve, reject, timer })
    child.stdin.write(`${JSON.stringify(message)}\n`)
  })
}

child.stdout.on('data', (chunk) => {
  buffered += chunk.toString('utf8')
  let index
  while ((index = buffered.indexOf('\n')) >= 0) {
    const line = buffered.slice(0, index).trim()
    buffered = buffered.slice(index + 1)
    if (line === '') continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    const entry = pending.get(message.id)
    if (entry === undefined) continue
    pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
    else entry.resolve(message.result)
  }
})

child.stderr.on('data', (chunk) => {
  const text = chunk.toString('utf8').trim()
  if (text !== '') console.log(`[stderr] ${text.slice(0, 400)}`)
})

const kill = () => {
  try {
    child.kill()
  } catch {
    // Already gone.
  }
}

try {
  const init = await send('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'dsh-windows-mcp-smoke', version: '0.1.0' },
  })
  console.log(`server ${JSON.stringify(init?.serverInfo ?? {})}`)
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)

  const list = await send('tools/list', {})
  const tools = (list?.tools ?? []).map((tool) => tool.name)
  console.log(`tools ${tools.length}: ${tools.join(', ')}`)

  for (const banned of ['PowerShell', 'Registry', 'FileSystem', 'Process']) {
    console.log(`excluded ${banned}: ${tools.includes(banned) ? 'STILL PRESENT' : 'absent'}`)
  }
} catch (error) {
  console.error('handshake failed:', error.message)
  process.exitCode = 1
} finally {
  kill()
}
