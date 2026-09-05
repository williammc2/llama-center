/**
 * App self-update: checks the latest GitHub release of llama-center itself.
 *
 * The CI publishes the installer as a release asset on every push to main.
 * This module fetches the latest release, compares versions, and returns
 * the installer URL + release notes for the UI to display.
 */

export interface AppRelease {
  version: string
  tag: string
  notes: string
  installerUrl: string | null
  publishedAt: string | null
}

const REPO = 'williammc2/llama-center'
const LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`

/** Parse a GitHub `releases/latest` payload into an AppRelease. */
export function parseAppRelease(raw: unknown): AppRelease {
  if (typeof raw !== 'object' || raw === null) throw new Error('app release: not an object')
  const o = raw as Record<string, unknown>

  const tag = typeof o.tag_name === 'string' ? o.tag_name : ''
  const m = /^v(\d+\.\d+\.\d+)$/.exec(tag)
  if (!m) throw new Error(`app release: bad tag ${tag}`)
  const version = m[1]

  const notes = typeof o.body === 'string' ? o.body : ''
  const publishedAt = typeof o.published_at === 'string' ? o.published_at : null

  // Find the Windows installer asset (.exe)
  let installerUrl: string | null = null
  const assets = Array.isArray(o.assets) ? (o.assets as Array<Record<string, unknown>>) : []
  for (const a of assets) {
    const name = typeof a.name === 'string' ? a.name : ''
    if (name.endsWith('.exe') && typeof a.browser_download_url === 'string') {
      installerUrl = a.browser_download_url
      break
    }
  }

  return { version, tag, notes, installerUrl, publishedAt }
}

/** Compare semver strings. Returns >0 if a > b, 0 if equal, <0 if a < b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * Fetch the latest release and determine if an update is available.
 * Returns null when up-to-date, or the AppRelease when a newer version exists.
 */
export async function checkAppUpdate(
  currentVersion: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AppRelease | null> {
  const res = await fetchImpl(LATEST_URL, { headers: { accept: 'application/vnd.github+json' } })
  if (!res.ok) throw new Error(`app update: HTTP ${res.status}`)
  const release = parseAppRelease(await res.json())
  if (compareVersions(release.version, currentVersion) > 0) return release
  return null
}
