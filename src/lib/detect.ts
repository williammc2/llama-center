/**
 * Runtime detection: OS, arch, and CUDA presence.
 *
 * Pure functions taking a small `Env` input so they're testable in Node/vitest
 * without a real browser or Rust. The Tauri shell (P6) calls `detect()` which
 * assembles the Env from Tauri APIs; in a plain browser it falls back to
 * `navigator`. CUDA detection (`nvidia-smi` probe) is done in Rust later —
 * here we just model the result.
 */
import type { Backend } from './assetResolver'
import { backendsFor } from './assetResolver'

export type DetectedOs = 'win' | 'linux' | 'macos' | 'unknown'
export type DetectedArch = 'x64' | 'arm64' | 'unknown'

export interface Env {
  /** e.g. `navigator.platform` / Tauri OS string. */
  platform: string
  /** e.g. `navigator.userAgent`. */
  userAgent: string
  /** Result of `nvidia-smi` probe: true if an NVIDIA GPU + driver is present. */
  nvidiaPresent?: boolean
}

export interface Detection {
  os: DetectedOs
  arch: DetectedArch
  /** Backends the wizard should offer for this OS (per-OS matrix). */
  backends: readonly Backend[]
  /** Auto-detect suggested a CUDA backend (nvidia-smi found a GPU). */
  suggestCuda: boolean
}

export function detectOs(platform: string, userAgent: string): DetectedOs {
  const s = `${platform} ${userAgent}`.toLowerCase()
  // darwin/mac before win — 'darwin' contains 'win'
  if (s.includes('mac') || s.includes('darwin')) return 'macos'
  if (s.includes('win')) return 'win'
  if (s.includes('linux')) return 'linux'
  return 'unknown'
}

export function detectArch(userAgent: string): DetectedArch {
  const ua = userAgent.toLowerCase()
  if (ua.includes('arm') || ua.includes('aarch64')) return 'arm64'
  if (ua.includes('x64') || ua.includes('x86_64') || ua.includes('amd64')) return 'x64'
  return 'unknown'
}

/**
 * Build the wizard's detection result. Backends come from the per-OS matrix;
 * `suggestCuda` is true only when the OS offers cuda AND a GPU was detected.
 */
export function detect(env: Env): Detection {
  const os = detectOs(env.platform, env.userAgent)
  const arch = detectArch(env.userAgent)
  const backends = (os === 'win' || os === 'linux' || os === 'macos') ? backendsFor(os) : []
  const suggestCuda = os === 'win' && !!env.nvidiaPresent && backends.includes('cuda')
  return { os, arch, backends, suggestCuda }
}

/** Convenience for a plain browser environment. */
export function detectFromNavigator(navigator: Navigator): Detection {
  return detect({ platform: navigator.platform, userAgent: navigator.userAgent })
}
