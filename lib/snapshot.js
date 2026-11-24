/**
 * The persisted health snapshot.
 *
 * `state.json` is the answer to "what did the last probe find" without re-running
 * every probe after a restart. That only stays true if every path that changes the
 * answer rewrites it — so the snapshot lives in one pure function and callers
 * persist it after provisioning, registration, and upgrades alike.
 */

/**
 * Coarse health, matching the three states the design asks for.
 *
 * - `blocked`:     nothing can be provisioned (no interpreter, no payload runtime).
 * - `actionable`:  something is missing but the plugin or the user can fix it
 *                  (no engine yet, pip broken, name collision).
 * - `ready`:       an engine exists and its MCP server is registered.
 * @param {{ python: object|null, pip?: object|null, engine: object, registration: object }} input
 * @returns {'ready'|'actionable'|'blocked'}
 */
export function assessHealth({ python, pip, engine, registration }) {
  if (python === null || python === undefined) return 'blocked'
  if (pip !== null && pip !== undefined && pip.ok === false) return 'actionable'
  if (engine.mode === 'none') return 'actionable'
  if (registration === null || registration === undefined || registration.registered !== true) return 'actionable'
  return 'ready'
}

/**
 * Build the fields `state.json` stores for one probe result.
 *
 * @param {{
 *   python: object|null,
 *   pythonRejected: object[],
 *   pip: object|null,
 *   engine: object,
 *   registration: object,
 *   tools: object,
 *   payload: object,
 *   now?: string,
 * }} input
 * @returns {{ lastDetectAt: string, health: string, detect: object }}
 */
export function buildDetectState(input) {
  const { python, pythonRejected, pip, engine, registration, tools, payload, now } = input
  return {
    lastDetectAt: now ?? new Date().toISOString(),
    health: assessHealth({ python, pip, engine, registration }),
    detect: {
      python: python === null || python === undefined
        ? null
        : { version: python.version, path: python.path, source: python.source },
      pythonRejected: Array.isArray(pythonRejected) ? pythonRejected.slice(0, 8) : [],
      pip: pip === null || pip === undefined ? null : { ok: pip.ok === true, version: pip.version ?? null, reason: pip.reason ?? null },
      engine: { mode: engine.mode, version: engine.version ?? null, venvDir: engine.venvDir },
      registration,
      tools,
      payload: payload === null || payload === undefined
        ? null
        : { dir: payload.dir, exists: payload.exists === true, wheelhouse: payload.wheelhouse ?? '', python: payload.python ?? '' },
    },
  }
}
