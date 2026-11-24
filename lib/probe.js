/**
 * Engine probe: one stdio MCP handshake against an engine executable.
 *
 * Used for three things, all before a version is promoted:
 *   1. does the new code start and answer at all;
 *   2. what tool names does it expose (the drift check's input);
 *   3. what does `initialize` report about the server.
 *
 * The probe is stateless and always kills its child.
 */
import { spawn } from 'node:child_process'

const DEFAULT_TIMEOUT_MS = 45000

function rpcSession(child, timeoutMs) {
  let buffered = ''
  let nextId = 1
  const pending = new Map()

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
      if (message.error !== undefined) entry.reject(new Error(JSON.stringify(message.error)))
      else entry.resolve(message.result)
    }
  })

  return {
    send(method, params) {
      const id = nextId++
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`${method} timed out after ${timeoutMs} ms`))
        }, timeoutMs)
        pending.set(id, { resolve, reject, timer })
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      })
    },
    failAll(error) {
      for (const [, entry] of pending) {
        clearTimeout(entry.timer)
        entry.reject(error)
      }
      pending.clear()
    },
  }
}

/**
 * @param {{ command: string, args: string[], env: object, cwd: string }} entry
 * @returns {Promise<{ ok: boolean, tools: string[], serverInfo: object|null, error: string, stderr: string }>}
 */
export function probeEngine(entry, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false
    let stderr = ''
    const finish = (value) => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch {
        // Already gone.
      }
      resolve(value)
    }

    let child
    try {
      child = spawn(entry.command, entry.args, {
        cwd: entry.cwd,
        env: { ...process.env, ...entry.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ ok: false, tools: [], serverInfo: null, error: String(error?.message ?? error), stderr: '' })
      return
    }

    const session = rpcSession(child, timeoutMs)
    const deadline = setTimeout(() => finish({ ok: false, tools: [], serverInfo: null, error: `probe timed out after ${timeoutMs} ms`, stderr }), timeoutMs)

    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4000)
    })
    child.on('error', (error) => {
      clearTimeout(deadline)
      finish({ ok: false, tools: [], serverInfo: null, error: String(error?.message ?? error), stderr })
    })
    child.on('exit', (code) => {
      session.failAll(new Error(`engine exited (code ${code}) during probe`))
      clearTimeout(deadline)
      finish({ ok: false, tools: [], serverInfo: null, error: `engine exited with code ${code}`, stderr })
    })

    void (async () => {
      try {
        const initialize = await session.send('initialize', {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'dsh-windows-mcp', version: '0.1.0' },
        })
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
        const listed = await session.send('tools/list', {})
        const tools = Array.isArray(listed?.tools) ? listed.tools.map((tool) => String(tool?.name ?? '')).filter((name) => name !== '') : []
        clearTimeout(deadline)
        finish({ ok: true, tools, serverInfo: initialize?.serverInfo ?? null, error: '', stderr })
      } catch (error) {
        clearTimeout(deadline)
        finish({ ok: false, tools: [], serverInfo: null, error: String(error?.message ?? error), stderr })
      }
    })()
  })
}
