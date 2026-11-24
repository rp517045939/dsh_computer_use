/**
 * Durable plugin state: what the last detection found, which engine version is
 * installed, and what the release channel last reported.
 *
 * Only diagnostics are stored. The engine and venv themselves are the truth;
 * this file lets the status surface answer instantly after a restart without
 * re-running every probe.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const STATE_VERSION = 1

export function statePath(config) {
  return join(config.engineDir, 'state.json')
}

export function readState(config) {
  try {
    const parsed = JSON.parse(readFileSync(statePath(config), 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function writeState(config, value) {
  mkdirSync(config.engineDir, { recursive: true })
  const target = statePath(config)
  const temporary = `${target}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temporary, target)
  return value
}

export function patchState(config, patch) {
  const current = readState(config)
  return writeState(config, { ...current, ...patch, version: STATE_VERSION })
}
