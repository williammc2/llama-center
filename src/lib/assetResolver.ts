/**
 * llama.cpp nightly asset resolver.
 *
 * The llama.cpp "release" is not a stable version — it is a stream of nightlies
 * tagged `b####`, each shipping a heterogeneous set of prebuilt binaries. The
 * asset names are NOT uniform (see the real b10814 set in the test fixture),
 * so this module does two things:
 *
 *   1. `parseAsset` — turn a raw asset filename + size into a structured record.
 *   2. `resolve`    — given a (os, arch, backend, cudaMajor, family) request,
 *                     pick the right asset via a fallback chain, or report why
 *                     no asset exists (a first-class state, e.g. Linux+CUDA).
 *
 * Pure functions, no I/O — everything is unit-testable against real data.
 */

export type Os = 'win' | 'ubuntu' | 'macos' | 'android'
export type Arch = 'x64' | 'arm64' | 's390x'
export type Backend = 'cpu' | 'cuda' | 'vulkan' | 'rocm' | 'openvino' | 'sycl' | 'opencl'
export type Family = 'cudart' | 'plain'
export type Ext = 'zip' | 'tar.gz'

export interface ParsedAsset {
  /** Original filename, e.g. `cudart-llama-bin-win-cuda-12.4-x64.zip`. */
  name: string
  os: Os
  arch: Arch
  backend: Backend
  /** Full version token when the backend carries one: `12.4`, `10.0`, `2026.3.1`, `fp16`, `adreno`. */
  version?: string
  /** CUDA major only, derived from `version` (e.g. `12.4` → 12). */
  cudaMajor?: number
  /** Only meaningful for cuda: `cudart` bundles the runtime, `plain` needs the toolkit. */
  family: Family
  /** Nightly build tag, e.g. `b10814`. Absent on the cudart stubs and special assets. */
  build?: string
  ext: Ext
  sizeMB: number
}

/** A request for a single prebuilt binary. `os` is user-facing (linux→ubuntu). */
export interface ResolveRequest {
  os: 'win' | 'linux' | 'macos'
  arch: 'x64' | 'arm64'
  backend: 'cpu' | 'cuda' | 'vulkan' | 'rocm' | 'openvino' | 'sycl' | 'opencl'
  /** CUDA major to prefer (12 or 13). Omit to accept whatever is present. */
  cudaMajor?: number
  /** CUDA family; defaults to `cudart` (self-contained, no toolkit required). */
  family?: Family
  /**
   * When true, `cudaMajor` is a hard constraint: the resolver prefers the
   * requested major in the *other* family over the requested family at the
   * wrong major. Default false = current behavior (family > major). Use this
   * when the major is genuinely required (e.g. an RTX 5090 that needs CUDA 13).
   */
  hardMajor?: boolean
  /**
   * SYCL precision, only meaningful for ubuntu sycl (assets ship fp16/fp32).
   * Windows sycl has no precision axis and ignores this. Defaults to `fp16`
   * when the axis exists and none is given — a stated default, overridable.
   */
  syclPrecision?: 'fp16' | 'fp32'
}

export type ResolveResult =
  | { status: 'ok'; asset: ParsedAsset; fellBack: boolean; reason?: string }
  | { status: 'no-asset'; reason: string; available: string[] }

const BACKENDS = new Set<string>(['cpu', 'cuda', 'vulkan', 'rocm', 'openvino', 'sycl', 'opencl'])
/** Backends whose asset name carries a version token right after the keyword. */
const VERSIONED = new Set<string>(['cuda', 'rocm', 'openvino', 'sycl', 'opencl'])
const ARCHS = new Set<string>(['x64', 'arm64', 's390x'])
const OS_AFTER_BIN = new Set<string>(['win', 'ubuntu', 'macos', 'android'])

/**
 * Parse one asset filename. Token-based (not a single regex — the real asset
 * set is too heterogeneous for one template). Returns null for names that are
 * not a runnable binary we care about (e.g. `llama-b10814-xcframework.zip`,
 * `llama-b10814-ui.tar.gz` — neither contains a `bin` segment).
 *
 * Shape handled: `[cudart-]llama-[-b####-]bin-<os>[-<backend>[-<version>]]-<arch>.<ext>`
 */
export function parseAsset(name: string, sizeMB: number): ParsedAsset | null {
  const ext: Ext | null = name.endsWith('.tar.gz') ? 'tar.gz' : name.endsWith('.zip') ? 'zip' : null
  if (!ext) return null
  // ext is stored without its leading dot; remove the dot too (`.zip` = 4, `.tar.gz` = 7).
  const tokens = name.slice(0, name.length - ext.length - 1).split('-')

  const family: Family = tokens[0] === 'cudart' ? 'cudart' : 'plain'
  const buildTok = tokens.find((t) => /^b\d+$/.test(t))

  const binIdx = tokens.indexOf('bin')
  if (binIdx === -1) return null // not a standard binary (xcframework, ui, ...)
  const after = tokens.slice(binIdx + 1)
  if (after.length < 2) return null

  const osTok = after[0]
  if (!osTok || !OS_AFTER_BIN.has(osTok)) return null
  const archTok = after[after.length - 1]
  if (!archTok || !ARCHS.has(archTok)) return null

  const middle = after.slice(1, after.length - 1)
  let backend: Backend = 'cpu'
  let version: string | undefined
  const mid0 = middle[0]
  if (mid0 !== undefined && BACKENDS.has(mid0)) {
    backend = mid0 as Backend
    if (VERSIONED.has(mid0)) version = middle[1]
  }

  let cudaMajor: number | undefined
  if (backend === 'cuda' && version) {
    const dot = version.indexOf('.')
    cudaMajor = Number(version.slice(0, dot === -1 ? version.length : dot))
  }

  return { name, os: osTok as Os, arch: archTok as Arch, backend, version, cudaMajor, family, build: buildTok, ext, sizeMB }
}

/** Parse a list of raw assets, dropping the ones that are not runnable binaries. */
export function parseAssets(raw: ReadonlyArray<{ name: string; sizeMB: number }>): ParsedAsset[] {
  const out: ParsedAsset[] = []
  for (const r of raw) {
    const p = parseAsset(r.name, r.sizeMB)
    if (p) out.push(p)
  }
  return out
}

const OS_MAP: Record<ResolveRequest['os'], Os> = { win: 'win', linux: 'ubuntu', macos: 'macos' }

/**
 * Architectural backend matrix per OS — the *known* set the wizard renders
 * before it has fetched anything. The load-bearing fact here is the asymmetry:
 * **Linux has no CUDA asset** (verified across the last 60 nightlies), so a
 * symmetric "CUDA 12/13/Vulkan/CPU" dropdown is wrong for Linux users.
 *
 * This is a *superset* of what any single build ships. The wizard intersects it
 * with the fetched build's real assets (that's what `resolve`'s `no-asset`
 * state is for) — so a backend listed here may still be unavailable in a
 * specific nightly, and `resolve` will say so with an `available[]` list.
 */
export const BACKENDS_BY_OS: Record<ResolveRequest['os'], readonly Backend[]> = {
  win: ['cpu', 'cuda', 'vulkan', 'rocm', 'sycl', 'openvino', 'opencl'],
  linux: ['cpu', 'vulkan', 'rocm', 'sycl', 'openvino'], // NOTE: no cuda
  macos: ['cpu'],
}

/** Backends the wizard should offer for a given OS. */
export function backendsFor(os: ResolveRequest['os']): readonly Backend[] {
  return BACKENDS_BY_OS[os]
}

function versionDesc(a: ParsedAsset, b: ParsedAsset): number {
  return (b.version ?? '').localeCompare(a.version ?? '', undefined, { numeric: true })
}

function pickHighest(pool: ParsedAsset[]): ParsedAsset | null {
  if (pool.length === 0) return null
  const sorted = [...pool].sort(versionDesc)
  const top = sorted[0]
  return top ?? null
}

function resolveNonCuda(pool: ParsedAsset[], req: ResolveRequest): ResolveResult {
  if (req.backend !== 'sycl') {
    const top = pickHighest(pool)
    return { status: 'ok', asset: top!, fellBack: false }
  }

  // SYCL on ubuntu has fp16/fp32 precision axis
  const hasPrecisionAxis = pool.some((a) => a.version === 'fp16' || a.version === 'fp32')
  if (!hasPrecisionAxis) {
    const top = pickHighest(pool)
    return { status: 'ok', asset: top!, fellBack: false }
  }

  const precision = req.syclPrecision ?? 'fp16'
  const exact = pool.filter((a) => a.version === precision)
  if (exact.length > 0) {
    return { status: 'ok', asset: pickHighest(exact)!, fellBack: false }
  }

  const fallback = pickHighest(pool)!
  return { status: 'ok', asset: fallback, fellBack: true, reason: `sycl ${precision} not available; using ${fallback.version}` }
}

/** Human-readable list of what IS available for a (os, arch) cell, for error UI. */
function describe(assets: ParsedAsset[], os: Os, arch: Arch): string[] {
  return assets
    .filter((a) => a.os === os && a.arch === arch)
    .map((a) => `${a.backend}${a.version ? '-' + a.version : ''}${a.family === 'cudart' && a.backend === 'cuda' ? ' (cudart)' : ''}`)
    .sort()
}

export function resolve(assets: ParsedAsset[], req: ResolveRequest): ResolveResult {
  const os = OS_MAP[req.os]
  const inCell = assets.filter((a) => a.os === os && a.arch === req.arch && a.backend === req.backend)

  if (inCell.length === 0) {
    return {
      status: 'no-asset',
      reason: `no ${req.backend} build for ${os}-${req.arch}`,
      available: describe(assets, os, req.arch),
    }
  }

  if (req.backend !== 'cuda') {
    return resolveNonCuda(inCell, req)
  }

  const family = req.family ?? 'cudart'
  const sameFamily = inCell.filter((a) => a.family === family)
  const otherFamily = inCell.filter((a) => a.family !== family)

  // No major specified: pick highest from same family, fallback to other
  if (req.cudaMajor == null) {
    const exact = pickHighest(sameFamily)
    if (exact) return { status: 'ok', asset: exact, fellBack: false }

    const fallback = pickHighest(otherFamily)
    return {
      status: 'ok',
      asset: fallback!,
      fellBack: true,
      reason: `${family} family not available for ${os}-${req.arch}; using ${fallback!.family} family`,
    }
  }

  // Exact match: same family, same major
  const exact = pickHighest(sameFamily.filter((a) => a.cudaMajor === req.cudaMajor))
  if (exact) return { status: 'ok', asset: exact, fellBack: false }

  // hardMajor: prefer right major in other family over wrong major in same family
  if (req.hardMajor) {
    const otherExact = pickHighest(otherFamily.filter((a) => a.cudaMajor === req.cudaMajor))
    if (otherExact) {
      return {
        status: 'ok',
        asset: otherExact,
        fellBack: true,
        reason: `cuda-${req.cudaMajor}.* not available in ${family} family; using ${otherExact.family} family (hardMajor)`,
      }
    }
  }

  // Same family, different major
  const sameFamilyFallback = pickHighest(sameFamily)
  if (sameFamilyFallback) {
    return {
      status: 'ok',
      asset: sameFamilyFallback,
      fellBack: true,
      reason: `cuda-${req.cudaMajor}.* not available; using cuda-${sameFamilyFallback.cudaMajor}.* (${family} family)`,
    }
  }

  // Last resort: other family, any major
  const lastResort = pickHighest(otherFamily)
  return {
    status: 'ok',
    asset: lastResort!,
    fellBack: true,
    reason: `${family} family not available; using ${lastResort!.family} family`,
  }
}

export interface BuildInfo {
  tag: string
  assets: ParsedAsset[]
}

export interface LatestResult {
  build: BuildInfo
  resolution: ResolveResult
  /** True when the chosen build is the newest b#### overall. */
  isAbsoluteNewest: boolean
  /** How many newer b#### builds were skipped because they lacked this combo. */
  skippedNewer: number
}

function buildNum(tag: string): number {
  return Number(tag.slice(1))
}

/**
 * Update-check core: walk builds newest→oldest and return the first one that
 * actually has an asset for the request. A newer b#### may lack the exact
 * (os, arch, cuda-major, family) combo, so "newest" is per-request, not global.
 */
export function resolveLatest(builds: ReadonlyArray<BuildInfo>, req: ResolveRequest): LatestResult | null {
  const bb = builds
    .filter((b) => /^b\d+$/.test(b.tag))
    .sort((a, b) => buildNum(b.tag) - buildNum(a.tag))
  let skipped = 0
  for (const b of bb) {
    const r = resolve(b.assets, req)
    if (r.status === 'ok') {
      return { build: b, resolution: r, isAbsoluteNewest: skipped === 0, skippedNewer: skipped }
    }
    skipped++
  }
  return null
}
