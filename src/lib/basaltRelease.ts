/**
 * basalt release client (stable releases, GitHub jesdga95/basalt).
 *
 * basalt ships one asset per OS per release (verified against v0.5.7):
 *   basalt-v{ver}-{os}-x64.{zip|tar.gz}   os: windows|linux
 * tagged `v{ver}` (ver is semver).
 *
 * Same pattern as llamaSwapRelease — parse the latest release, pick the
 * asset for the host. Pure functions + one thin fetch wrapper.
 */

export type BasaltOs = 'windows' | 'linux'
export type BasaltExt = 'zip' | 'tar.gz'

export interface BasaltAsset {
  name: string
  os: BasaltOs
  arch: 'amd64'
  ext: BasaltExt
  url: string
  /** SHA-256 from the GitHub asset digest; null when the API omitted it. */
  sha256: string | null
  sizeBytes: number
}

export interface BasaltRelease {
  tag: string
  version: string
  assets: BasaltAsset[]
  publishedAt: string | null
}

export const DEFAULT_LATEST_URL =
  'https://api.github.com/repos/jesdga95/basalt/releases/latest'

const ASSET_RE = /^basalt-v(\d+(?:\.\d+)*)-(windows|linux)-x64\.(zip|tar\.gz)$/

export function parseAssetName(
  name: string,
): { version: string; os: BasaltOs; ext: BasaltExt } | null {
  const m = ASSET_RE.exec(name)
  if (!m) return null
  return { version: m[1]!, os: m[2] as BasaltOs, ext: m[3] as BasaltExt }
}

interface RawAsset {
  name?: unknown
  browser_download_url?: unknown
  digest?: unknown
  size?: unknown
}

/**
 * Validate + coerce a GitHub `releases/latest` payload. Throws on anything
 * malformed (the UI shows the message).
 */
export function parseRelease(raw: unknown): BasaltRelease {
  if (typeof raw !== 'object' || raw === null) throw new Error('release: not an object')
  const o = raw as Record<string, unknown>
  const tag = o.tag_name
  if (typeof tag !== 'string' || !/^v\d+(?:\.\d+)*$/.test(tag)) {
    throw new Error(`release: bad tag ${String(tag)}`)
  }
  const version = tag.slice(1)

  const assets: BasaltAsset[] = []
  const rawAssets = Array.isArray(o.assets) ? (o.assets as RawAsset[]) : []
  for (const a of rawAssets) {
    const name = typeof a.name === 'string' ? a.name : null
    if (!name) continue
    const parsed = parseAssetName(name)
    if (!parsed) continue
    const url = typeof a.browser_download_url === 'string' ? a.browser_download_url : null
    if (!url) continue
    let sha256: string | null = null
    if (typeof a.digest === 'string' && a.digest.startsWith('sha256:')) {
      sha256 = a.digest.slice('sha256:'.length).toLowerCase()
    }
    assets.push({
      name,
      os: parsed.os,
      arch: 'amd64',
      ext: parsed.ext,
      url,
      sha256,
      sizeBytes: typeof a.size === 'number' ? a.size : 0,
    })
  }
  if (assets.length === 0) throw new Error('release: no usable assets')

  const publishedAt = typeof o.published_at === 'string' ? o.published_at : null
  return { tag, version, assets, publishedAt }
}

const OS_MAP = { win: 'windows', linux: 'linux' } as const

/** Pick the asset for a host (user-facing os/arch). Null when the release has none. */
export function pickAsset(
  release: BasaltRelease,
  os: keyof typeof OS_MAP,
): BasaltAsset | null {
  return release.assets.find((a) => a.os === OS_MAP[os]) ?? null
}

/** Compare semver-ish version strings. >0 means a > b. */
export function compareVersions(a: string, b: string): number {
  const to = (v: string) => v.split('.').map((p) => Number(p) || 0)
  const pa = to(a)
  const pb = to(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** Fetch + parse the latest release. `fetchImpl` is injectable for tests. */
export async function fetchLatestRelease(
  url: string = DEFAULT_LATEST_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<BasaltRelease> {
  const res = await fetchImpl(url, { headers: { accept: 'application/vnd.github+json' } })
  if (!res.ok) throw new Error(`release: HTTP ${res.status} from ${url}`)
  return parseRelease(await res.json())
}
