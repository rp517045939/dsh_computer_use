/**
 * Reach the tool-definition helper across install layouts.
 *
 * A profile bundle installed from a local directory is linked, not copied, so its
 * bare imports resolve from its own directory tree — not from the dsh installation
 * that owns `@deepseek-ai/dsh-tools`. This module tries the documented import
 * first, then the dsh installation inside `app.asar`, and finally reports a plain
 * definition the registry accepts directly.
 */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

function installCandidates() {
  const bases = []
  const resources = process.resourcesPath
  if (typeof resources === 'string' && resources !== '') {
    bases.push(join(resources, 'app.asar', 'dsh', 'node_modules'))
    bases.push(join(resources, 'app.asar.unpacked', 'dsh', 'node_modules'))
    bases.push(join(resources, 'app', 'node_modules'))
  }
  const installDir = process.env.DSH_INSTALL_DIR
  if (typeof installDir === 'string' && installDir !== '') {
    bases.push(join(installDir, 'resources', 'app.asar', 'dsh', 'node_modules'))
    bases.push(join(installDir, 'node_modules'))
  }
  return bases.map((base) => join(base, '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'))
}

/**
 * @returns {Promise<{ defineTool: ((definition: object) => object)|null, via: string, error: string }>}
 */
export async function loadDefineTool() {
  const errors = []
  try {
    const module = await import('@deepseek-ai/dsh-tools')
    if (typeof module.defineTool === 'function') return { defineTool: module.defineTool, via: 'package import', error: '' }
    errors.push('package import: no defineTool export')
  } catch (error) {
    errors.push(`package import: ${error?.message ?? error}`)
  }
  for (const file of installCandidates()) {
    try {
      const module = await import(pathToFileURL(file).href)
      if (typeof module.defineTool === 'function') return { defineTool: module.defineTool, via: `install file ${file}`, error: '' }
      errors.push(`${file}: no defineTool export`)
    } catch (error) {
      errors.push(`${file}: ${error?.message ?? error}`)
    }
  }
  return { defineTool: null, via: 'none', error: errors.join(' | ') }
}

/**
 * Fallback definition for the registry when no helper is reachable.
 * The registry validates arguments against `parameters` itself, and both fields
 * are already in the wire format the helper would have produced.
 */
export function plainDefinition(definition) {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    output: definition.output,
    execute: definition.execute,
  }
}
