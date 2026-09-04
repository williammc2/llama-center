/**
 * The bridge — the ONLY place in the UI that touches the host system.
 *
 * Two implementations, same interface:
 *   - pywebview:  window.pywebview.api (Python backend, real fs writes)
 *   - browser:    localStorage stand-in (dev mode, `pnpm dev`)
 *
 * The wizard (and everything after it) calls these functions and never
 * knows which shell it's in.
 */
import { parseConfig, serializeConfig, type AppConfig } from './config'
import type { Detection } from './detect'

export interface Bridge {
  /** Current config on disk, or null (first run). */
  getConfig(): Promise<AppConfig | null>
  /** Validate + persist. Throws with a readable message on corrupt input. */
  saveConfig(cfg: AppConfig): Promise<string>
  /** Host detection: OS, arch, CUDA hint, offered backends. */
  getDetection(): Promise<Detection>
}

/* pywebview exposes the Python Api object here. */
interface PywebviewApi {
  get_detection(): Promise<Detection>
  get_config(): Promise<Record<string, unknown> | null | { error: string }>
  save_config(raw: Record<string, unknown>): Promise<{ path?: string; error?: string }>
}

declare global {
  interface Window {
    pywebview?: { api: PywebviewApi }
  }
}

export function isPywebview(): boolean {
  return typeof window !== 'undefined' && !!window.pywebview?.api
}

const pywebview: Bridge = {
  async getDetection() {
    return window.pywebview!.api.get_detection()
  },
  async getConfig() {
    const raw = await window.pywebview!.api.get_config()
    if (raw === null) return null
    if (typeof raw === 'object' && 'error' in raw) throw new Error('config on disk is corrupt')
    return parseConfig(raw)
  },
  async saveConfig(cfg) {
    const res = await window.pywebview!.api.save_config(cfg as unknown as Record<string, unknown>)
    if (res.error) throw new Error(res.error)
    return res.path!
  },
}

/**
 * Browser stand-in for `pnpm dev` — no Python shell, so config lives in
 * localStorage. Lets the whole UI be developed and tested without the shell.
 */
const browser: Bridge = {
  async getDetection() {
    // Reuse the navigator-based detector already in detect.ts.
    const { detectFromNavigator } = await import('./detect')
    return detectFromNavigator(navigator)
  },
  async getConfig() {
    const raw = localStorage.getItem('llama-center:config')
    if (!raw) return null
    try {
      return parseConfig(JSON.parse(raw))
    } catch {
      throw new Error('config on disk is corrupt')
    }
  },
  async saveConfig(cfg) {
    localStorage.setItem('llama-center:config', serializeConfig(cfg))
    return 'localStorage'
  },
}

export const bridge: Bridge = isPywebview() ? pywebview : browser
