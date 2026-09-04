/**
 * llama.cpp nightly discovery.
 *
 * Unlike llama-swap (one `latest` release), llama.cpp is a stream of nightly
 * releases tagged `b####` on ggml-org/llama.cpp. "Latest" is per-request: the
 * newest b#### that actually ships an asset for the user's (os, arch,
 * backend, cuda-major, family) — older builds may lack the combo, so we walk
 * releases newest→oldest and let `resolveLatest` do the picking.
 *
 * The releases-list API returns newest first and mixes in non-nightly tags
 * (e.g. the old `v0.4.0` stub), which `parseBuild` filters out.
 *
 * The resolver's ParsedAsset carries no URL/digest, so each build also keeps
 * the raw asset metadata — `assetMeta` maps a resolved asset name back to its
 * download URL + SHA-256. The download/verify/swap bytes go through Python
 * (updater.py), mirroring llamaSwapRelease.ts.
 */
import { parseAssets, resolveLatest, type BuildInfo, type LatestResult, type ResolveRequest } from './assetResolver'

export const DEFAULT_RELEASES_URL = 'https://api.github.com/repos/ggml-org/llama.cpp/releases'

/** Raw asset metadata needed to download a resolved asset. */
export interface AssetMeta {
  name: string
  url: string
  sha256: string | null
  sizeBytes: number
}

/** One nightly: resolver-facing info + raw metadata for the download. */
export interface ParsedBuild {
  info: BuildInfo
  rawAssets: AssetMeta[]
}

export interface NightlyCheck {
  /** The b#### builds fetched (newest first). */
  builds: ParsedBuild[]
  /** Resolution of the request against those builds; null = no build has an asset for it. */
  latest: LatestResult | null
}

/** Raw asset metadata from a GitHub release payload. Null when not usable. */
function parseAssetMeta(a: Record<string, unknown>): AssetMeta | null {
  const name = typeof a.name === 'string' ? a.name : null
  const url = typeof a.browser_download_url === 'string' ? a.browser_download_url : null
  if (!name || !url) return null
  let sha256: string | null = null
  if (typeof a.digest === 'string' && a.digest.startsWith('sha256:')) {
    sha256 = a.digest.slice('sha256:'.length).toLowerCase()
  }
  return { name, url, sha256, sizeBytes: typeof a.size === 'number' ? a.size : 0 }
}

/** Parse one GitHub release payload. Null when not a b#### nightly. */
export function parseBuild(raw: unknown): ParsedBuild | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  const tag = o.tag_name
  if (typeof tag !== 'string' || !/^b\d+$/.test(tag)) return null
  const rawAssets = Array.isArray(o.assets) ? (o.assets as Array<Record<string, unknown>>) : []
  const metas: AssetMeta[] = []
  const forResolver: Array<{ name: string; sizeMB: number }> = []
  for (const a of rawAssets) {
    const meta = parseAssetMeta(a)
    if (!meta) continue
    metas.push(meta)
    forResolver.push({ name: meta.name, sizeMB: meta.sizeBytes / (1024 * 1024) })
  }
  return { info: { tag, assets: parseAssets(forResolver) }, rawAssets: metas }
}

/** Map a resolved asset name back to its download URL + SHA-256. */
export function assetMeta(build: ParsedBuild, assetName: string): AssetMeta | null {
  return build.rawAssets.find((m) => m.name === assetName) ?? null
}

/**
 * Fetch the newest `count` nightly builds and resolve the best one for `req`.
 * Pages the releases API (100/page) until `count` b#### builds are collected
 * or the API runs dry. `fetchImpl` is injectable for tests.
 */
export async function checkNightly(
  req: ResolveRequest,
  count: number = 30,
  url: string = DEFAULT_RELEASES_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<NightlyCheck> {
  const builds: ParsedBuild[] = []
  const perPage = 100
  for (let page = 1; page <= 10 && builds.length < count; page++) {
    const res = await fetchImpl(`${url}?per_page=${perPage}&page=${page}`, {
      headers: { accept: 'application/vnd.github+json' },
    })
    if (!res.ok) throw new Error(`nightly: HTTP ${res.status} from ${url}`)
    const data = (await res.json()) as unknown
    if (!Array.isArray(data) || data.length === 0) break
    for (const r of data) {
      const b = parseBuild(r)
      if (b) builds.push(b)
      if (builds.length >= count) break
    }
  }
  return { builds, latest: resolveLatest(builds.map((b) => b.info), req) }
}

/** Build the resolver request from app config + host detection. */
export function requestFromConfig(
  cfg: { backend: ResolveRequest['backend']; cudaMajor?: number; cudaFamily?: 'cudart' | 'plain' },
  os: ResolveRequest['os'],
  arch: ResolveRequest['arch'],
): ResolveRequest {
  return {
    os,
    arch,
    backend: cfg.backend,
    cudaMajor: cfg.cudaMajor,
    family: cfg.cudaFamily,
    // The wizard's CUDA-major choice is a hard constraint (e.g. an RTX 5090
    // that needs CUDA 13 must not silently get cudart-12.4).
    hardMajor: cfg.backend === 'cuda' && cfg.cudaMajor != null,
  }
}
