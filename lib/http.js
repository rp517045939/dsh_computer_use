/** Bounded HTTPS JSON/text helpers. No dependencies; every request has a deadline. */
import { get } from 'node:https'

function request(url, timeoutMs, headers, transform) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    try {
      const req = get(url, { headers, timeout: timeoutMs }, (response) => {
        if (response.statusCode !== 200) {
          response.resume()
          finish({ ok: false, error: `HTTP ${response.statusCode}` })
          return
        }
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          try {
            finish({ ok: true, value: transform(Buffer.concat(chunks).toString('utf8')) })
          } catch (error) {
            finish({ ok: false, error: `invalid response: ${error.message}` })
          }
        })
        response.on('error', (error) => finish({ ok: false, error: String(error.message) }))
      })
      req.on('timeout', () => {
        req.destroy()
        finish({ ok: false, error: 'timed out' })
      })
      req.on('error', (error) => finish({ ok: false, error: String(error.message) }))
    } catch (error) {
      finish({ ok: false, error: String(error?.message ?? error) })
    }
  })
}

const USER_AGENT = 'dsh-windows-mcp'

/** @returns {Promise<{ ok: boolean, value?: any, error?: string }>} */
export function httpsJson(url, timeoutMs = 6000) {
  return request(url, timeoutMs, { 'user-agent': USER_AGENT, accept: 'application/json' }, (text) => JSON.parse(text))
}

/** @returns {Promise<{ ok: boolean, text?: string, error?: string }>} */
export function httpsText(url, timeoutMs = 6000) {
  return request(url, timeoutMs, { 'user-agent': USER_AGENT, accept: 'application/atom+xml,text/xml,*/*' }, (text) => text)
}
