/**
 * App config — the single JSON file llama-center reads on every start.
 * Lived at `%LOCALAPPDATA%\llama-center\config.json` (win) /
 * `~/.local/share/llama-center/config.json` (linux).
 *
 * Deliberately separate from `llama-swap.json` (the llama-swap daemon's own
 * config, which lives in the llama-swap install dir and is edited in P4).
 */
import type { Backend } from './assetResolver'

export type Lang = 'en' | 'pt-BR'

export interface AppConfig {
  /** Schema version for forward-compat migrations. */
  version: 1
  /** First-run wizard finished. */
  firstRunDone: boolean
  /** Root install dir (e.g. `%LOCALAPPDATA%\llama-center`). */
  installDir: string
  /** llama.cpp backend chosen in the wizard. */
  backend: Backend
  /** Requested CUDA major (12/13) — only meaningful when backend=cuda. */
  cudaMajor?: 12 | 13
  /** CUDA family; defaults to `cudart` (self-contained). */
  cudaFamily?: 'cudart' | 'plain'
  /** Pinned llama.cpp nightly (e.g. `b10814`); null = latest-with-asset. */
  llamaCppPin: string | null
  /** llama-swap port. */
  llamaSwapPort: number
  /** UI language; default `en`. */
  lang: Lang
  /** App starts minimized to tray on login (P5). */
  startWithSystem: boolean
  /** llama-swap auto-starts when the app starts (P5). */
  autoStartLlamaSwap: boolean
  /** Close-to-tray instead of taskbar (P5). */
  closeToTray: boolean
  /** Update checks on start + manual button (Q7: both). */
  checkUpdatesOnStart: boolean
}

export const DEFAULT_CONFIG: AppConfig = {
  version: 1,
  firstRunDone: false,
  installDir: '',
  backend: 'cpu',
  cudaFamily: 'cudart',
  llamaCppPin: null,
  llamaSwapPort: 8085,
  lang: 'en',
  startWithSystem: false,
  autoStartLlamaSwap: false,
  closeToTray: true,
  checkUpdatesOnStart: true,
}

/**
 * Validate + coerce raw JSON into an AppConfig. Unknown keys are dropped,
 * missing keys fall back to defaults, wrong types throw (so the wizard can
 * show "corrupt config" with a reset option instead of crashing).
 */
export function parseConfig(raw: unknown): AppConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('config: not an object')
  }
  const o = raw as Record<string, unknown>
  if (o.version !== 1) {
    throw new Error(`config: unsupported version ${String(o.version)} (expected 1)`)
  }
  const str = (v: unknown): string => {
    if (typeof v !== 'string') throw new Error('config: expected string')
    return v
  }
  const bool = (v: unknown, dflt: boolean): boolean => (typeof v === 'boolean' ? v : dflt)
  // Missing (undefined) → default; present but not a positive int → throw.
  const num = (v: unknown, dflt: number): number => {
    if (v === undefined) return dflt
    if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) throw new Error('config: expected positive int')
    return v
  }

  const backend = (o.backend ?? 'cpu') as Backend
  if (!['cpu', 'cuda', 'vulkan', 'rocm', 'sycl', 'openvino', 'opencl'].includes(backend)) {
    throw new Error(`config: unknown backend ${String(backend)}`)
  }
  const cudaMajor = o.cudaMajor === 12 || o.cudaMajor === 13 ? o.cudaMajor : undefined
  const lang = (o.lang ?? 'en') as Lang
  if (!['en', 'pt-BR'].includes(lang)) throw new Error(`config: unknown lang ${String(lang)}`)

  return {
    version: 1,
    firstRunDone: bool(o.firstRunDone, false),
    installDir: str(o.installDir ?? ''),
    backend,
    cudaMajor,
    cudaFamily: o.cudaFamily === 'plain' ? 'plain' : 'cudart',
    llamaCppPin: o.llamaCppPin === null || typeof o.llamaCppPin === 'string' ? o.llamaCppPin : null,
    llamaSwapPort: num(o.llamaSwapPort, DEFAULT_CONFIG.llamaSwapPort),
    lang,
    startWithSystem: bool(o.startWithSystem, false),
    autoStartLlamaSwap: bool(o.autoStartLlamaSwap, false),
    closeToTray: bool(o.closeToTray, true),
    checkUpdatesOnStart: bool(o.checkUpdatesOnStart, true),
  }
}

export function serializeConfig(cfg: AppConfig): string {
  return JSON.stringify(cfg, null, 2) + '\n'
}
