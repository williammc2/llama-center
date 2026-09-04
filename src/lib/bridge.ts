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
  /** Download a llama-swap release asset, verify SHA-256, extract to staging.
   *  Returns the directory holding the payload. */
  downloadAndStage(url: string, sha256: string | null): Promise<string>
  /** Swap staging into the live llama-swap dir (previous install → backups).
   *  Returns the backup dir name, or null on a first install. */
  swapLlamaSwap(): Promise<string | null>
  /** Restore the newest backup. False when there is nothing to restore. */
  rollbackLlamaSwap(): Promise<boolean>
  /** Backup dir names, newest first. */
  listLlamaSwapBackups(): Promise<string[]>
  /** True when something listens on 127.0.0.1:<port>. */
  probePort(port: number): Promise<boolean>
  /** Best-effort kill of a running llama-swap. True when a process was killed. */
  stopLlamaSwap(): Promise<boolean>
}

/* pywebview exposes the Python Api object here. */
interface PywebviewApi {
  get_detection(): Promise<Detection>
  get_config(): Promise<Record<string, unknown> | null | { error: string }>
  save_config(raw: Record<string, unknown>): Promise<{ path?: string; error?: string }>
  download_and_stage(url: string, sha256: string | null): Promise<{ staging?: string; error?: string }>
  swap_llama_swap(): Promise<{ backup?: string | null; error?: string }>
  rollback_llama_swap(): Promise<{ rolledBack?: boolean; error?: string }>
  list_llama_swap_backups(): Promise<string[]>
  probe_port(port: number): Promise<boolean>
  stop_llama_swap(): Promise<boolean>
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
  async downloadAndStage(url, sha256) {
    const res = await window.pywebview!.api.download_and_stage(url, sha256)
    if (res.error) throw new Error(res.error)
    return res.staging!
  },
  async swapLlamaSwap() {
    const res = await window.pywebview!.api.swap_llama_swap()
    if (res.error) throw new Error(res.error)
    return res.backup ?? null
  },
  async rollbackLlamaSwap() {
    const res = await window.pywebview!.api.rollback_llama_swap()
    if (res.error) throw new Error(res.error)
    return res.rolledBack === true
  },
  async listLlamaSwapBackups() {
    return window.pywebview!.api.list_llama_swap_backups()
  },
  async probePort(port) {
    return window.pywebview!.api.probe_port(port)
  },
  async stopLlamaSwap() {
    return window.pywebview!.api.stop_llama_swap()
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
  // No Python shell in the browser: the update *decision* still works (pure
  // TS), but the bytes need the real fs.
  async downloadAndStage() {
    throw new Error('needs the desktop shell — run via dev.bat (pnpm dev has no filesystem)')
  },
  async swapLlamaSwap() {
    throw new Error('needs the desktop shell — run via dev.bat (pnpm dev has no filesystem)')
  },
  async rollbackLlamaSwap() {
    throw new Error('needs the desktop shell — run via dev.bat (pnpm dev has no filesystem)')
  },
  async listLlamaSwapBackups() {
    return []
  },
  async probePort() {
    return false
  },
  async stopLlamaSwap() {
    return false
  },
}

export const bridge: Bridge = isPywebview() ? pywebview : browser
