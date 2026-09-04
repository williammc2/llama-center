/**
 * llama-swap release client (stable releases — unlike llama.cpp nightlies).
 *
 * llama-swap ships a uniform asset set per release (verified against v253):
 *   llama-swap_{ver}_{os}_{arch}.{zip|tar.gz}   os: windows|linux|darwin|freebsd
 *   llama-swap_{ver}_checksums.txt              (sha256sum format)
 * tagged `v{ver}`.
 *
 * This module does the update *decision* — parse the GitHub `releases/latest`
 * payload, pick the asset for a host, parse the checksums file. Pure functions
 * plus one thin fetch wrapper, so it's fully testable in Node; Python only
 * downloads / verifies / swaps (see backend/llama_center/updater.py).
 *
 * The SHA-256 used for verification comes from the GitHub asset `digest`
 * (computed at upload time — authoritative); checksums.txt is parsed too and
 * can be used as a cross-check.
 */

export type SwapOs = 'windows' | 'linux' | 'darwin' | 'freebsd'
export type SwapArch = 'amd64' | 'arm64'
export type SwapExt = 'zip' | 'tar.gz'

export interface SwapAsset {
  name: string
  os: SwapOs
  arch: SwapArch
  ext: SwapExt
  version: number
  url: string
  /** SHA-256 from the GitHub asset digest; null when the API omitted it. */
  sha256: string | null
  sizeBytes: number
}

export interface SwapRelease {
  tag: string
  version: number
  assets: SwapAsset[]
  checksumsUrl: string | null
  publishedAt: string | null
}

export const DEFAULT_LATEST_URL = 'https://api.github.com/repos/mostlygeek/llama-swap/releases/latest'

const ASSET_RE = /^llama-swap_(\d+)_(windows|linux|darwin|freebsd)_(amd64|arm64)\.(zip|tar\.gz)$/
const CHECKSUMS_RE = /^llama-swap_(\d+)_checksums\.txt$/

/** Parse one release asset filename. Null for names that are not a binary. */
export function parseAssetName(
  name: string,
): { version: number; os: SwapOs; arch: SwapArch; ext: SwapExt } | null {
  const m = ASSET_RE.exec(name)
  if (!m) return null
  return { version: Number(m[1]), os: m[2] as SwapOs, arch: m[3] as SwapArch, ext: m[4] as SwapExt }
}

interface RawAsset {
  name?: unknown
  browser_download_url?: unknown
  digest?: unknown
  size?: unknown
}

/**
 * Validate + coerce a GitHub `releases/latest` payload into a SwapRelease.
 * Throws with a readable message on anything malformed (the UI shows it).
 */
export function parseRelease(raw: unknown): SwapRelease {
  if (typeof raw !== 'object' || raw === null) throw new Error('release: not an object')
  const o = raw as Record<string, unknown>
  const tag = o.tag_name
  if (typeof tag !== 'string' || !/^v\d+$/.test(tag)) throw new Error(`release: bad tag ${String(tag)}`)
  const version = Number(tag.slice(1))

  const assets: SwapAsset[] = []
  let checksumsUrl: string | null = null
  const rawAssets = Array.isArray(o.assets) ? (o.assets as RawAsset[]) : []
  for (const a of rawAssets) {
    const name = typeof a.name === 'string' ? a.name : null
    if (!name) continue
    const cs = CHECKSUMS_RE.exec(name)
    if (cs) {
      if (Number(cs[1]) === version && typeof a.browser_download_url === 'string') {
        checksumsUrl = a.browser_download_url
      }
      continue
    }
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
      arch: parsed.arch,
      ext: parsed.ext,
      version: parsed.version,
      url,
      sha256,
      sizeBytes: typeof a.size === 'number' ? a.size : 0,
    })
  }
  if (assets.length === 0) throw new Error('release: no usable assets')

  const publishedAt = typeof o.published_at === 'string' ? o.published_at : null
  return { tag, version, assets, checksumsUrl, publishedAt }
}

const OS_MAP = { win: 'windows', linux: 'linux', macos: 'darwin' } as const
const ARCH_MAP = { x64: 'amd64', arm64: 'arm64' } as const

/** Pick the asset for a host (user-facing os/arch). Null when the release has none. */
export function pickAsset(
  release: SwapRelease,
  os: keyof typeof OS_MAP,
  arch: keyof typeof ARCH_MAP,
): SwapAsset | null {
  return release.assets.find((a) => a.os === OS_MAP[os] && a.arch === ARCH_MAP[arch]) ?? null
}

/** Parse a sha256sum-format checksums file: `<hash>  <filename>` per line. */
export function parseChecksums(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const m = /^([0-9a-fA-F]{64})\s+(\S+)$/.exec(trimmed)
    if (m) out[m[2]] = m[1].toLowerCase()
  }
  return out
}

/** Fetch + parse the latest release. `fetchImpl` is injectable for tests. */
export async function fetchLatestRelease(
  url: string = DEFAULT_LATEST_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<SwapRelease> {
  const res = await fetchImpl(url, { headers: { accept: 'application/vnd.github+json' } })
  if (!res.ok) throw new Error(`release: HTTP ${res.status} from ${url}`)
  return parseRelease(await res.json())
}
