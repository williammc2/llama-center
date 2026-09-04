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
  if (!OS_AFTER_BIN.has(osTok)) return null
  const archTok = after[after.length - 1]
  if (!ARCHS.has(archTok)) return null

  const middle = after.slice(1, after.length - 1)
  let backend: Backend = 'cpu'
  let version: string | undefined
  if (middle.length > 0 && BACKENDS.has(middle[0])) {
    backend = middle[0] as Backend
    if (VERSIONED.has(middle[0]) && middle.length > 1) version = middle[1]
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

function pickHighest(pool: ParsedAsset[]): ParsedAsset {
  return [...pool].sort(versionDesc)[0]
}

/**
 * Pick for a non-CUDA backend. SYCL on ubuntu ships both `fp16` and `fp32` —
 * a real precision choice, not a no-op — so honor `syclPrecision` (default
 * `fp16`, the standard for LLM weights) instead of letting `pickHighest`
 * coin-flip to fp32. Backends without a version axis (cpu, vulkan, win sycl)
 * are a direct pick.
 */
function resolveVersioned(pool: ParsedAsset[], req: ResolveRequest): ResolveResult {
  if (req.backend === 'sycl') {
    const hasAxis = pool.some((a) => a.version === 'fp16' || a.version === 'fp32')
    if (hasAxis) {
      const prec = req.syclPrecision ?? 'fp16'
      const exact = pool.filter((a) => a.version === prec)
      if (exact.length > 0) return { status: 'ok', asset: pickHighest(exact), fellBack: false }
      return { status: 'ok', asset: pickHighest(pool), fellBack: true, reason: `sycl ${prec} not available; using ${pickHighest(pool).version}` }
    }
  }
  return { status: 'ok', asset: pickHighest(pool), fellBack: false }
}

/** Human-readable list of what IS available for a (os, arch) cell, for error UI. */
function describe(assets: ParsedAsset[], os: Os, arch: Arch): string[] {
  return assets
    .filter((a) => a.os === os && a.arch === arch)
    .map((a) => `${a.backend}${a.version ? '-' + a.version : ''}${a.family === 'cudart' && a.backend === 'cuda' ? ' (cudart)' : ''}`)
    .sort()
}

/**
 * Resolve a request against one build's asset set.
 *
 * Fallback chain (CUDA): exact major+family → any major+family → any major+other family.
 * Non-CUDA backends have no version axis, so it is a direct pick.
 */
export function resolve(assets: ParsedAsset[], req: ResolveRequest): ResolveResult {
  const os = OS_MAP[req.os]
  const inCell = assets.filter((a) => a.os === os && a.arch === req.arch && a.backend === req.backend)
  if (inCell.length === 0) {
    return { status: 'no-asset', reason: `no ${req.backend} build for ${os}-${req.arch}`, available: describe(assets, os, req.arch) }
  }

  if (req.backend !== 'cuda') {
    return resolveVersioned(inCell, req)
  }

  const fam: Family = req.family ?? 'cudart'
  const sameFam = inCell.filter((a) => a.family === fam)
  const otherFam = inCell.filter((a) => a.family !== fam)

  type Tier = { pool: ParsedAsset[]; fellBack: boolean; reason?: string }
  const tiers: Tier[] = []
  if (req.cudaMajor != null) {
    const want = req.cudaMajor
    tiers.push({ pool: sameFam.filter((a) => a.cudaMajor === want), fellBack: false })
    // hardMajor: the requested major is a hard constraint → prefer the right
    // major in the *other* family over the requested family at the wrong major.
    // (e.g. an RTX 5090 that needs CUDA 13 should get plain-13.x, not cudart-12.4.)
    if (req.hardMajor) {
      tiers.push({
        pool: otherFam.filter((a) => a.cudaMajor === want),
        fellBack: true,
        reason: `cuda-${want}.* not available in ${fam} family for ${os}-${req.arch}; using ${otherFam[0]?.family ?? 'other'} family (hardMajor)`,
      })
    }
    const present = [...new Set(sameFam.map((a) => a.cudaMajor).filter((m): m is number => m != null))].sort((a, b) => b - a)
    tiers.push({
      pool: sameFam,
      fellBack: true,
      reason: `cuda-${want}.* not available for ${os}-${req.arch} (${fam}); available majors: ${present.map((m) => m).join(', ') || 'none'}`,
    })
    tiers.push({ pool: otherFam, fellBack: true, reason: `${fam} family not available for ${os}-${req.arch}; using ${otherFam[0]?.family ?? 'other'} family` })
  } else {
    tiers.push({ pool: sameFam, fellBack: false })
    tiers.push({ pool: otherFam, fellBack: true, reason: `${fam} family not available for ${os}-${req.arch}; using ${otherFam[0]?.family ?? 'other'} family` })
  }

  for (const t of tiers) {
    if (t.pool.length > 0) {
      return { status: 'ok', asset: pickHighest(t.pool), fellBack: t.fellBack, reason: t.reason }
    }
  }
  return { status: 'no-asset', reason: `no cuda build for ${os}-${req.arch}`, available: describe(assets, os, req.arch) }
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
