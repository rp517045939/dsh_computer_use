/**
 * Tool-surface policy.
 *
 * `--exclude-tools` matches by name, so it silently stops protecting anything the
 * moment upstream renames a tool. Two probes make that visible: the augmented
 * surface (what the model would see) and the raw surface (everything upstream
 * ships). Every promotion re-derives both and refuses a version whose exclusions
 * no longer name a real tool, or whose exclusions stopped removing anything.
 */

const REQUIRED_EXCLUSIONS = ['PowerShell', 'Registry', 'FileSystem', 'Process']

/** Names implying process, shell, or filesystem reach; a new one means the policy did not apply. */
const SUSPICIOUS = /(shell|powershell|cmd|exec|command|regedit|registry|filesystem|delete|spawn|script)/i

function keySet(names) {
  return new Set(names.map((name) => String(name).toLowerCase()))
}

/**
 * @param {{ exclude: string[] }} config
 * @param {{ augmented: string[], raw: string[] }} surfaces - with and without `--exclude-tools`.
 * @param {string[]|null} previousTools - tool names recorded for the installed version (augmented).
 * @returns {{ ok: boolean, problems: string[], notes: string[], added: string[], removed: string[], excluded: string[] }}
 */
export function evaluateToolSurface(config, surfaces, previousTools) {
  const problems = []
  const notes = []
  const augmented = keySet(surfaces.augmented)
  const raw = keySet(surfaces.raw)
  const configured = Array.isArray(config.exclude) && config.exclude.length > 0 ? config.exclude : REQUIRED_EXCLUSIONS

  for (const name of configured) {
    const lower = name.toLowerCase()
    if (!raw.has(lower)) {
      problems.push(`"${name}" is no longer an upstream tool name, so excluding it protects nothing (renamed or removed)`)
    }
    if (augmented.has(lower)) {
      problems.push(`"${name}" is still exposed with --exclude-tools applied`)
    }
  }

  const excluded = surfaces.raw.filter((name) => !augmented.has(name.toLowerCase()))
  if (surfaces.raw.length > 0 && excluded.length === 0) {
    problems.push('--exclude-tools removed nothing from the upstream surface; the flag or its values changed shape')
  }

  const previous = previousTools === null || previousTools === undefined ? null : keySet(previousTools)
  const added = surfaces.augmented.filter((name) => previous !== null && !previous.has(name.toLowerCase()))
  const removed = previousTools === null || previousTools === undefined
    ? []
    : previousTools.filter((name) => !augmented.has(name.toLowerCase()))

  if (previous !== null) {
    for (const name of added) {
      if (SUSPICIOUS.test(name)) {
        problems.push(`new tool "${name}" matches a process/shell/filesystem pattern; review before promoting`)
      }
    }
  }

  if (excluded.length > 0) notes.push(`excluded upstream: ${excluded.join(', ')}`)

  return { ok: problems.length === 0, problems, notes, added, removed, excluded }
}

/** One-line summary for the update report. */
export function describeSurface(result) {
  if (result === null || result === undefined) return 'surface not evaluated'
  if (!result.ok) return `surface rejected: ${result.problems.join('; ')}`
  const parts = [`surface ok: ${result.added.length} added, ${result.removed.length} removed`]
  if (result.excluded.length > 0) parts.push(`excluded ${result.excluded.join('/')}`)
  return parts.join('; ')
}

export { REQUIRED_EXCLUSIONS }
