import { describe, it, expect } from 'vitest'
import { parseAssets, resolve, resolveLatest, backendsFor, BACKENDS_BY_OS, type ParsedAsset } from '../lib/assetResolver'

/**
 * Real asset list from ggml-org/llama.cpp nightly `b10814` (27 assets),
 * pulled from the GitHub API on 2026-09-04. Includes the non-binary assets
 * (ui, xcframework) to prove parseAssets drops them.
 */
const RAW_B10814: Array<{ name: string; sizeMB: number }> = [
  { name: 'cudart-llama-bin-win-cuda-12.4-x64.zip', sizeMB: 373 },
  { name: 'cudart-llama-bin-win-cuda-13.3-x64.zip', sizeMB: 372 },
  { name: 'cudart-llama-bin-win-cuda-13.4-arm64.zip', sizeMB: 146 },
  { name: 'llama-b10814-bin-android-arm64.tar.gz', sizeMB: 70 },
  { name: 'llama-b10814-bin-macos-arm64.tar.gz', sizeMB: 10 },
  { name: 'llama-b10814-bin-macos-x64.tar.gz', sizeMB: 10 },
  { name: 'llama-b10814-bin-ubuntu-arm64.tar.gz', sizeMB: 12 },
  { name: 'llama-b10814-bin-ubuntu-openvino-2026.3.1-x64.tar.gz', sizeMB: 95 },
  { name: 'llama-b10814-bin-ubuntu-rocm-10.0-x64.tar.gz', sizeMB: 208 },
  { name: 'llama-b10814-bin-ubuntu-s390x.tar.gz', sizeMB: 14 },
  { name: 'llama-b10814-bin-ubuntu-sycl-fp16-x64.tar.gz', sizeMB: 51 },
  { name: 'llama-b10814-bin-ubuntu-sycl-fp32-x64.tar.gz', sizeMB: 51 },
  { name: 'llama-b10814-bin-ubuntu-vulkan-arm64.tar.gz', sizeMB: 26 },
  { name: 'llama-b10814-bin-ubuntu-vulkan-x64.tar.gz', sizeMB: 32 },
  { name: 'llama-b10814-bin-ubuntu-x64.tar.gz', sizeMB: 15 },
  { name: 'llama-b10814-bin-win-cpu-arm64.zip', sizeMB: 11 },
  { name: 'llama-b10814-bin-win-cpu-x64.zip', sizeMB: 17 },
  { name: 'llama-b10814-bin-win-cuda-12.4-x64.zip', sizeMB: 242 },
  { name: 'llama-b10814-bin-win-cuda-13.3-x64.zip', sizeMB: 142 },
  { name: 'llama-b10814-bin-win-cuda-13.4-arm64.zip', sizeMB: 136 },
  { name: 'llama-b10814-bin-win-opencl-adreno-arm64.zip', sizeMB: 12 },
  { name: 'llama-b10814-bin-win-openvino-2026.3.1-x64.zip', sizeMB: 76 },
  { name: 'llama-b10814-bin-win-rocm-10.0-x64.zip', sizeMB: 232 },
  { name: 'llama-b10814-bin-win-sycl-x64.zip', sizeMB: 114 },
  { name: 'llama-b10814-bin-win-vulkan-x64.zip', sizeMB: 33 },
  { name: 'llama-b10814-ui.tar.gz', sizeMB: 2 },
  { name: 'llama-b10814-xcframework.zip', sizeMB: 82 },
]

const B10814: ParsedAsset[] = parseAssets(RAW_B10814)

describe('parseAssets', () => {
  it('drops non-binary assets (ui, xcframework)', () => {
    expect(B10814.length).toBe(25) // 27 raw - ui - xcframework
    expect(B10814.some((a) => a.name.includes('xcframework'))).toBe(false)
    expect(B10814.some((a) => a.name.endsWith('ui.tar.gz'))).toBe(false)
  })

  it('marks cudart stubs with no build tag and family=cudart', () => {
    const cudart = B10814.find((a) => a.name === 'cudart-llama-bin-win-cuda-12.4-x64.zip')!
    expect(cudart.family).toBe('cudart')
    expect(cudart.build).toBeUndefined()
    expect(cudart.cudaMajor).toBe(12)
    expect(cudart.version).toBe('12.4')
  })

  it('parses plain cuda builds with build tag', () => {
    const plain = B10814.find((a) => a.name === 'llama-b10814-bin-win-cuda-13.3-x64.zip')!
    expect(plain.family).toBe('plain')
    expect(plain.build).toBe('b10814')
    expect(plain.cudaMajor).toBe(13)
  })

  it('parses backends with no version token as cpu/vulkan', () => {
    const cpu = B10814.find((a) => a.name === 'llama-b10814-bin-ubuntu-x64.tar.gz')!
    expect(cpu.backend).toBe('cpu')
    expect(cpu.version).toBeUndefined()
    const vulkan = B10814.find((a) => a.name === 'llama-b10814-bin-ubuntu-vulkan-x64.tar.gz')!
    expect(vulkan.backend).toBe('vulkan')
    expect(vulkan.version).toBeUndefined()
  })
})

describe('resolve — CUDA major fallback chain', () => {
  it('exact match: win x64 cuda-12 cudart', () => {
    const r = resolve(B10814, { os: 'win', arch: 'x64', backend: 'cuda', cudaMajor: 12, family: 'cudart' })
    expect(r.status).toBe('ok')
    if (r.status === 'ok') {
      expect(r.fellBack).toBe(false)
      expect(r.asset.name).toBe('cudart-llama-bin-win-cuda-12.4-x64.zip')
    }
  })

  it('falls back major: win ARM64 cuda-12 → only 13.4 exists → picks 13.4, flags fellBack', () => {
    const r = resolve(B10814, { os: 'win', arch: 'arm64', backend: 'cuda', cudaMajor: 12, family: 'cudart' })
    expect(r.status).toBe('ok')
    if (r.status === 'ok') {
      expect(r.fellBack).toBe(true)
      expect(r.asset.name).toBe('cudart-llama-bin-win-cuda-13.4-arm64.zip')
      expect(r.asset.cudaMajor).toBe(13)
      expect(r.reason).toMatch(/cuda-12\.\* not available/)
    }
  })

  it('power user: win x64 cuda-13 plain (slim, no runtime) → exact', () => {
    const r = resolve(B10814, { os: 'win', arch: 'x64', backend: 'cuda', cudaMajor: 13, family: 'plain' })
    expect(r.status).toBe('ok')
    if (r.status === 'ok') {
      expect(r.fellBack).toBe(false)
      expect(r.asset.name).toBe('llama-b10814-bin-win-cuda-13.3-x64.zip')
    }
  })

  it('defaults family to cudart when omitted', () => {
    const r = resolve(B10814, { os: 'win', arch: 'x64', backend: 'cuda', cudaMajor: 13 })
    expect(r.status).toBe('ok')
    if (r.status === 'ok') expect(r.asset.family).toBe('cudart')
  })
})

describe('resolve — the Linux+CUDA dead end is a first-class state', () => {
  it('linux x64 cuda-13 → no-asset with a useful "available" list', () => {
    const r = resolve(B10814, { os: 'linux', arch: 'x64', backend: 'cuda', cudaMajor: 13 })
    expect(r.status).toBe('no-asset')
    if (r.status === 'no-asset') {
      expect(r.reason).toBe('no cuda build for ubuntu-x64')
      // The error UI can offer these real alternatives:
      expect(r.available).toContain('vulkan')
      expect(r.available).toContain('rocm-10.0')
      expect(r.available).toContain('cpu')
    }
  })

  it('linux x64 vulkan → ok (the real path for Linux GPU)', () => {
    const r = resolve(B10814, { os: 'linux', arch: 'x64', backend: 'vulkan' })
    expect(r.status).toBe('ok')
    if (r.status === 'ok') {
      expect(r.asset.name).toBe('llama-b10814-bin-ubuntu-vulkan-x64.tar.gz')
      expect(r.asset.os).toBe('ubuntu')
    }
  })

  it('linux arm64 vulkan → ok', () => {
    const r = resolve(B10814, { os: 'linux', arch: 'arm64', backend: 'vulkan' })
    expect(r.status).toBe('ok')
    if (r.status === 'ok') expect(r.asset.name).toBe('llama-b10814-bin-ubuntu-vulkan-arm64.tar.gz')
  })
})

describe('resolve — non-CUDA backends are direct picks', () => {
  it('win x64 cpu', () => {
    const r = resolve(B10814, { os: 'win', arch: 'x64', backend: 'cpu' })
    expect(r.status).toBe('ok')
    if (r.status === 'ok') expect(r.asset.name).toBe('llama-b10814-bin-win-cpu-x64.zip')
  })

  it('macos arm64 cpu', () => {
    const r = resolve(B10814, { os: 'macos', arch: 'arm64', backend: 'cpu' })
    expect(r.status).toBe('ok')
    if (r.status === 'ok') expect(r.asset.name).toBe('llama-b10814-bin-macos-arm64.tar.gz')
  })
})

describe('resolveLatest — "newest" is per-request, not global', () => {
  it('skips a newer build that lacks the exact combo and reports it', () => {
    // Synthetic: a newer nightly b99999 has NO win-arm64-cuda at all.
    const b99999: ParsedAsset[] = parseAssets([
      { name: 'llama-b99999-bin-win-cpu-x64.zip', sizeMB: 17 },
      { name: 'llama-b99999-bin-win-cuda-13.3-x64.zip', sizeMB: 142 },
    ])
    const result = resolveLatest(
      [
        { tag: 'b99999', assets: b99999 },
        { tag: 'b10814', assets: B10814 },
      ],
      { os: 'win', arch: 'arm64', backend: 'cuda', cudaMajor: 12 },
    )
    expect(result).not.toBeNull()
    if (result) {
      expect(result.build.tag).toBe('b10814')
      expect(result.isAbsoluteNewest).toBe(false)
      expect(result.skippedNewer).toBe(1)
      expect(result.resolution.status).toBe('ok')
      if (result.resolution.status === 'ok') {
        expect(result.resolution.asset.name).toBe('cudart-llama-bin-win-cuda-13.4-arm64.zip')
      }
    }
  })

  it('numeric ordering: b10814 > b10809, and filters the v0.3.0 stub out', () => {
    const result = resolveLatest(
      [
        { tag: 'v0.3.0', assets: [] },
        { tag: 'b10809', assets: [] },
        { tag: 'b10814', assets: B10814 },
      ],
      { os: 'win', arch: 'x64', backend: 'cpu' },
    )
    expect(result).not.toBeNull()
    if (result) {
      expect(result.build.tag).toBe('b10814')
      expect(result.isAbsoluteNewest).toBe(true)
      expect(result.skippedNewer).toBe(0)
    }
  })

  it('returns null when no build has the combo', () => {
    const result = resolveLatest([{ tag: 'b10814', assets: B10814 }], {
      os: 'linux',
      arch: 'x64',
      backend: 'cuda',
      cudaMajor: 13,
    })
    expect(result).toBeNull()
  })
})

describe('resolve — sycl precision (was a silent coin-flip)', () => {
  it('ubuntu x64 sycl defaults to fp16 (a stated default, not fp32)', () => {
    const r = resolve(B10814, { os: 'linux', arch: 'x64', backend: 'sycl' })
    expect(r.status).toBe('ok')
    if (r.status === 'ok') {
      expect(r.asset.name).toBe('llama-b10814-bin-ubuntu-sycl-fp16-x64.tar.gz')
      expect(r.fellBack).toBe(false)
    }
  })

  it('ubuntu x64 sycl fp32 → explicit override', () => {
    const r = resolve(B10814, { os: 'linux', arch: 'x64', backend: 'sycl', syclPrecision: 'fp32' })
    expect(r.status).toBe('ok')
    if (r.status === 'ok') expect(r.asset.name).toBe('llama-b10814-bin-ubuntu-sycl-fp32-x64.tar.gz')
  })

  it('windows x64 sycl has no precision axis → direct pick, ignores syclPrecision', () => {
    const r = resolve(B10814, { os: 'win', arch: 'x64', backend: 'sycl', syclPrecision: 'fp32' })
    expect(r.status).toBe('ok')
    if (r.status === 'ok') {
      expect(r.asset.name).toBe('llama-b10814-bin-win-sycl-x64.zip')
      expect(r.asset.version).toBeUndefined()
    }
  })

  it('requested precision absent (future nightly edge) → falls back to available with reason', () => {
    // b10814 always ships both precisions, so a synthetic single-precision
    // set exercises the fellBack branch: request fp32, only fp16 exists.
    const synth = parseAssets([{ name: 'llama-b10814-bin-ubuntu-sycl-fp16-x64.tar.gz', sizeMB: 51 }])
    const r = resolve(synth, { os: 'linux', arch: 'x64', backend: 'sycl', syclPrecision: 'fp32' })
    expect(r.status).toBe('ok')
    if (r.status === 'ok') {
      expect(r.fellBack).toBe(true)
      expect(r.asset.name).toBe('llama-b10814-bin-ubuntu-sycl-fp16-x64.tar.gz')
      expect(r.reason).toBe('sycl fp32 not available; using fp16')
    }
  })
})

describe('resolve — hardMajor (requested major as a hard constraint)', () => {
  it('real b10814: win x64 cuda-13 cudart is an EXACT match (both families ship 13.x on x64)', () => {
    // No fallback — the fixture has cudart-...-cuda-13.3-x64. This documents
    // that hardMajor is a no-op on this fixture (no major is missing from a
    // family for win-x64), which is why the divergence case needs synthetic data.
    const r = resolve(B10814, { os: 'win', arch: 'x64', backend: 'cuda', cudaMajor: 13, family: 'cudart' })
    expect(r.status).toBe('ok')
    if (r.status === 'ok') {
      expect(r.fellBack).toBe(false)
      expect(r.asset.name).toBe('cudart-llama-bin-win-cuda-13.3-x64.zip')
    }
  })

  it('synthetic: hardMajor reorders to right-major/other-family; default does not', () => {
    // c12 is cudart-only, c13 is plain-only for win-x64. Request cuda-13 cudart:
    //   default (family>major) → no cudart-13 → falls back to cudart-12 (WRONG major)
    //   hardMajor              → prefers plain-13 (RIGHT major, other family)
    const synth = parseAssets([
      { name: 'cudart-llama-bin-win-cuda-12.4-x64.zip', sizeMB: 373 },
      { name: 'llama-b10814-bin-win-cuda-13.0-x64.zip', sizeMB: 142 },
    ])
    const def = resolve(synth, { os: 'win', arch: 'x64', backend: 'cuda', cudaMajor: 13, family: 'cudart' })
    expect(def.status).toBe('ok')
    if (def.status === 'ok') {
      expect(def.fellBack).toBe(true)
      expect(def.asset.name).toBe('cudart-llama-bin-win-cuda-12.4-x64.zip') // family won, major lost
    }
    const hard = resolve(synth, { os: 'win', arch: 'x64', backend: 'cuda', cudaMajor: 13, family: 'cudart', hardMajor: true })
    expect(hard.status).toBe('ok')
    if (hard.status === 'ok') {
      expect(hard.fellBack).toBe(true)
      expect(hard.asset.name).toBe('llama-b10814-bin-win-cuda-13.0-x64.zip') // major won, family lost
      expect(hard.asset.cudaMajor).toBe(13)
      expect(hard.asset.family).toBe('plain')
    }
  })
})

describe('BACKENDS_BY_OS — per-OS wizard matrix (architect decision)', () => {
  it('Linux offers NO cuda (the load-bearing asymmetry)', () => {
    expect(BACKENDS_BY_OS.linux).not.toContain('cuda')
    expect(BACKENDS_BY_OS.linux).toContain('vulkan')
    expect(BACKENDS_BY_OS.linux).toContain('cpu')
  })

  it('Windows offers cuda (the symmetric case)', () => {
    expect(BACKENDS_BY_OS.win).toContain('cuda')
  })

  it('every backend the wizard offers for a given OS has a real b10814 asset for at least one arch', () => {
    // The wizard promises per-OS, not per-arch. So each offered backend must
    // exist for at least one arch of that OS — otherwise the wizard
    // over-promises (caught: win opencl is arm64-only, no x64 twin).
    for (const os of ['win', 'linux'] as const) {
      for (const backend of backendsFor(os)) {
        const anyArch = ['x64', 'arm64'].some(
          (arch) => resolve(B10814, { os, arch, backend }).status === 'ok',
        )
        expect(anyArch, `${os} ${backend} offered by wizard but no b10814 asset for any arch`).toBe(true)
      }
    }
  })

  it('backendsFor is a stable reference (no accidental mutation)', () => {
    expect(backendsFor('linux')).toBe(BACKENDS_BY_OS.linux)
  })

  it('documents the win-opencl arm64-only hole (Qualcomm Adreno, no x64 twin)', () => {
    // opencl is in the win matrix, but on b10814 it only ships for arm64.
    // A win-x64 user asking for opencl gets no-asset with an available[] list.
    const x64 = resolve(B10814, { os: 'win', arch: 'x64', backend: 'opencl' })
    expect(x64.status).toBe('no-asset')
    const arm = resolve(B10814, { os: 'win', arch: 'arm64', backend: 'opencl' })
    expect(arm.status).toBe('ok')
    if (arm.status === 'ok') expect(arm.asset.name).toBe('llama-b10814-bin-win-opencl-adreno-arm64.zip')
  })
})
