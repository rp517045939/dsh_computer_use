/**
 * Release channel: PyPI is the authority, the GitHub release feed is a
 * cross-check. The unauthenticated GitHub REST API is deliberately unused — it is
 * rate limited per IP and made a shared machine fail every check.
 *
 * Only published releases are visible here; `main`, arbitrary commits, and
 * prereleases are not part of this channel by design.
 */
import { httpsJson, httpsText } from './http.js'

const PYPI_JSON = 'https://pypi.org/pypi/windows-mcp/json'
const PYPI_VERSION_JSON = 'https://pypi.org/pypi/windows-mcp'
const RELEASE_FEED = 'https://github.com/CursorTouch/Windows-MCP/releases.atom'

function wheelDigest(files) {
  if (!Array.isArray(files)) return null
  const wheels = files.filter((file) => typeof file?.filename === 'string' && file.filename.endsWith('.whl'))
  const chosen = wheels.find((file) => /win_amd64\.whl$/.test(file.filename)) ?? wheels[0]
  if (chosen === undefined) return null
  const sha256 = chosen?.digests?.sha256
  return typeof sha256 === 'string' && sha256.length === 64 ? { filename: chosen.filename, sha256 } : null
}

/**
 * Newest published release.
 * @returns {Promise<{ ok: boolean, version?: string, yanked?: boolean, digest?: object|null, error?: string }>}
 */
export async function fetchLatestRelease(timeoutMs = 6000) {
  const response = await httpsJson(PYPI_JSON, timeoutMs)
  if (!response.ok) return { ok: false, error: response.error }
  const version = response.value?.info?.version
  if (typeof version !== 'string' || version === '') return { ok: false, error: 'no info.version in PyPI response' }
  const files = response.value?.releases?.[version]
  const yanked = Array.isArray(files) && files.length > 0 && files.every((file) => file?.yanked === true)
  return { ok: true, version, yanked, digest: wheelDigest(files) }
}

/**
 * Files and digests for one exact version, used before an install.
 * @returns {Promise<{ ok: boolean, digest?: object|null, error?: string }>}
 */
export async function fetchVersionArtifacts(version, timeoutMs = 6000) {
  const response = await httpsJson(`${PYPI_VERSION_JSON}/${encodeURIComponent(version)}/json`, timeoutMs)
  if (!response.ok) return { ok: false, error: response.error }
  const digest = wheelDigest(response.value?.urls)
  if (digest === null) return { ok: false, error: `no published wheel for ${version}` }
  return { ok: true, digest }
}

/**
 * Cross-check that the tag exists upstream. A failure here never blocks an
 * install: the wheel on PyPI is already the artifact being verified.
 * @returns {Promise<{ ok: boolean, found?: boolean, error?: string }>}
 */
export async function verifyReleaseTag(version, timeoutMs = 6000) {
  const response = await httpsText(RELEASE_FEED, timeoutMs)
  if (!response.ok) return { ok: false, error: response.error }
  const found = response.text.includes(`v${version}`) || response.text.includes(`>${version}<`)
  return { ok: true, found }
}

/** Compare two plain `major.minor.patch` versions. Returns <0, 0, >0. */
export function compareVersions(left, right) {
  const parse = (value) => String(value).split(/[.-]/).slice(0, 3).map((part) => {
    const number = Number.parseInt(part, 10)
    return Number.isFinite(number) ? number : 0
  })
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0)
  }
  return 0
}

/** Semver-ish sanity check for a user-supplied target version. */
export function isVersionLike(value) {
  return typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value)
}
