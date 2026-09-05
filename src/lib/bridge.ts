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

/** Download progress pushed from Python (throttled ~4x/s per file). */
export interface DownloadProgress {
  component: string
  file: string
  received: number
  total: number | null
}

/** llama-swap runtime status (polled ~2s by the UI). */
export interface SwapStatus {
  /** We spawned it and it is alive. */
  managed: boolean
  pid: number | null
  /** Something listens on the port (managed or external). */
  portBusy: boolean
  /** GET /health answered 200. */
  healthy: boolean
  /** Models reported by GET /running. */
  models: Array<{ model: string; state: string }>
}

/**
 * One model entry in the llama-swap config. The app renders these into the
 * `cmd` line; the llama-server path is abstracted (points at the managed
 * llama.cpp). Free-form `extraFlags` carries anything we don't expose as a
 * field (spec decoding, sampling, logging…).
 */
export interface SwapModelDef {
  name: string
  model: string
  mmproj?: string | null
  draft?: string | null
  ctxSize: number
  gpuLayers: number
  threads?: number | null
  extraFlags: string
}

export interface Bridge {
  /** Current config on disk, or null (first run). */
  getConfig(): Promise<AppConfig | null>
  /** Validate + persist. Throws with a readable message on corrupt input. */
  saveConfig(cfg: AppConfig): Promise<string>
  /** Host detection: OS, arch, CUDA hint, offered backends. */
  getDetection(): Promise<Detection>
  /** Download a release asset for a component ("llama-swap" | "llama-cpp"),
   *  verify SHA-256, extract to staging. Returns the payload directory.
   *  With `into`, the archive is merged into that directory (second asset,
   *  e.g. the Windows CUDA DLLs zip). */
  downloadAndStage(component: string, url: string, sha256: string | null, into?: string): Promise<string>
  /** Swap staging into the component's live dir (previous install → backups).
   *  Returns the backup dir name, or null on a first install. */
  swapComponent(component: string): Promise<string | null>
  /** Restore the component's newest backup. False when nothing to restore. */
  rollbackComponent(component: string): Promise<boolean>
  /** The component's backup dir names, newest first. */
  listComponentBackups(component: string): Promise<string[]>
  /** True when something listens on 127.0.0.1:<port>. */
  probePort(port: number): Promise<boolean>
  /** Spawn the installed llama-swap. error: "port-in-use" | "not-installed" | … */
  startLlamaSwap(): Promise<{ pid?: number; error?: string; port?: number }>
  /** Stop a running llama-swap (managed first, then by image name). */
  stopLlamaSwap(): Promise<{ stopped: boolean; exitCode: number | null }>
  /** Structured runtime status for the card (poll ~2s). */
  llamaSwapStatus(): Promise<SwapStatus>
  /** Last n lines of the managed process (newest last). */
  llamaSwapLogs(n?: number): Promise<string[]>
  /** Render model defs into llama-swap.yaml inside the install dir. */
  saveLlamaSwapConfig(models: SwapModelDef[]): Promise<{ path?: string; error?: string }>
  /** Read the managed config back into model defs (UI prefill). */
  getLlamaSwapConfig(): Promise<{ models: SwapModelDef[]; path: string | null }>
  /** Parse an existing config file (e.g. an old config.yaml) into model defs. */
  importLlamaSwapConfig(path: string): Promise<{ models?: SwapModelDef[]; error?: string }>
  /** Open a URL in the default browser. */
  openUrl(url: string): Promise<{ opened?: boolean; error?: string }>
  /** Open a folder in the OS file explorer. */
  openPath(path: string): Promise<{ opened?: boolean; error?: string }>
  /** Download the app installer and launch it (overwrites existing install). */
  downloadAndLaunchInstaller(url: string): Promise<{ launched?: boolean; closing?: boolean; error?: string }>
  /** Subscribe to download progress pushes. Returns an unsubscribe function. */
  onDownloadProgress(cb: (p: DownloadProgress) => void): Promise<() => void>
}

/* pywebview exposes the Python Api object here. */
interface PywebviewApi {
  get_detection(): Promise<Detection>
  get_config(): Promise<Record<string, unknown> | null | { error: string }>
  save_config(raw: Record<string, unknown>): Promise<{ path?: string; error?: string }>
  download_and_stage(
    component: string,
    url: string,
    sha256: string | null,
    into?: string,
  ): Promise<{ staging?: string; error?: string }>
  swap_component(component: string): Promise<{ backup?: string | null; error?: string }>
  rollback_component(component: string): Promise<{ rolledBack?: boolean; error?: string }>
  list_component_backups(component: string): Promise<string[]>
  probe_port(port: number): Promise<boolean>
  start_llama_swap(): Promise<{ pid?: number; error?: string; port?: number }>
  stop_llama_swap(): Promise<{ stopped?: boolean; exitCode?: number | null }>
  llama_swap_status(): Promise<SwapStatus>
  llama_swap_logs(n?: number): Promise<string[]>
  save_llama_swap_config(models: SwapModelDef[]): Promise<{ path?: string; error?: string }>
  get_llama_swap_config(): Promise<{ models: SwapModelDef[]; path: string | null }>
  import_llama_swap_config(path: string): Promise<{ models?: SwapModelDef[]; error?: string }>
  open_url(url: string): Promise<{ opened?: boolean; error?: string }>
  open_path(path: string): Promise<{ opened?: boolean; error?: string }>
  download_and_launch_installer(url: string): Promise<{ launched?: boolean; closing?: boolean; error?: string }>
}

declare global {
  interface Window {
    pywebview?: { api: PywebviewApi }
    /** Set by the pywebview bridge; Python pushes download progress here. */
    __lcProgress?: (p: DownloadProgress) => void
    /** Set by the active page; the tray "Check for updates" calls it. */
    __lcCheckUpdates?: () => void
  }
}

export function isPywebview(): boolean {
  return typeof window !== 'undefined' && !!window.pywebview?.api
}

/**
 * True when the pywebview API is actually callable — not merely present.
 *
 * pywebview 6.x injects the API in TWO steps: `api.js` first creates
 * `window.pywebview` with an EMPTY `api: {}`, and only later (in the
 * NavigationCompleted handler) `finish.js` fills in the real functions.
 * Waiting on `api !== undefined` therefore exits during that gap, and the
 * first `get_config()` call throws `TypeError: not a function` — the cause
 * of the eternal "Loading…" after a self-update (first cold boot, when the
 * gap is widest). A populated check (`typeof get_config === 'function'`)
 * is immune: the empty object keeps the caller waiting.
 */
export function isApiReady(): boolean {
  return isPywebview() && typeof window.pywebview!.api.get_config === 'function'
}

/**
 * Download-progress subscribers (Python pushes via `window.__lcProgress`).
 * A SET, not a single slot: the Shell (app installer), the Server page and
 * the llama.cpp page all subscribe, and each page unmounts when you navigate
 * away. A single slot meant the last subscriber to register won — and an
 * unmount could delete the slot under the others, silently killing the
 * sidebar's installer progress after the first page switch.
 */
const progressSubscribers = new Set<(p: DownloadProgress) => void>()
let progressWired = false

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
  async downloadAndStage(component, url, sha256, into) {
    const res = await window.pywebview!.api.download_and_stage(component, url, sha256, into)
    if (res.error) throw new Error(res.error)
    return res.staging!
  },
  async swapComponent(component) {
    const res = await window.pywebview!.api.swap_component(component)
    if (res.error) throw new Error(res.error)
    return res.backup ?? null
  },
  async rollbackComponent(component) {
    const res = await window.pywebview!.api.rollback_component(component)
    if (res.error) throw new Error(res.error)
    return res.rolledBack === true
  },
  async listComponentBackups(component) {
    return window.pywebview!.api.list_component_backups(component)
  },
  async probePort(port) {
    return window.pywebview!.api.probe_port(port)
  },
  async startLlamaSwap() {
    return window.pywebview!.api.start_llama_swap()
  },
  async stopLlamaSwap() {
    const res = await window.pywebview!.api.stop_llama_swap()
    return { stopped: res.stopped === true, exitCode: res.exitCode ?? null }
  },
  async llamaSwapStatus() {
    return window.pywebview!.api.llama_swap_status()
  },
  async llamaSwapLogs(n = 200) {
    return window.pywebview!.api.llama_swap_logs(n)
  },
  async saveLlamaSwapConfig(models) {
    return window.pywebview!.api.save_llama_swap_config(models)
  },
  async getLlamaSwapConfig() {
    return window.pywebview!.api.get_llama_swap_config()
  },
  async importLlamaSwapConfig(path) {
    return window.pywebview!.api.import_llama_swap_config(path)
  },
  async openUrl(url) {
    return window.pywebview!.api.open_url(url)
  },
  async openPath(path) {
    return window.pywebview!.api.open_path(path)
  },
  async downloadAndLaunchInstaller(url) {
    const res = await window.pywebview!.api.download_and_launch_installer(url)
    if (res.error) throw new Error(res.error)
    return { launched: res.launched === true, closing: res.closing === true }
  },
  async onDownloadProgress(cb) {
    progressSubscribers.add(cb)
    if (!progressWired) {
      progressWired = true
      window.__lcProgress = (p) => {
        for (const sub of progressSubscribers) {
          try {
            sub(p)
          } catch {
            // one broken subscriber must not kill the others
          }
        }
      }
    }
    return () => {
      progressSubscribers.delete(cb)
      if (progressSubscribers.size === 0) {
        progressWired = false
        delete window.__lcProgress
      }
    }
  },
}

/**
 * Browser stand-in for `pnpm dev` — no Python shell, so config lives in
 * localStorage. Lets the whole UI be developed and tested without the shell.
 */
const SHELL_ONLY = 'needs the desktop shell — run via dev.bat (pnpm dev has no filesystem)'
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
    throw new Error(SHELL_ONLY)
  },
  async swapComponent() {
    throw new Error(SHELL_ONLY)
  },
  async rollbackComponent() {
    throw new Error(SHELL_ONLY)
  },
  async listComponentBackups() {
    return []
  },
  async probePort() {
    return false
  },
  async startLlamaSwap() {
    return { error: 'not-installed' }
  },
  async stopLlamaSwap() {
    return { stopped: false, exitCode: null }
  },
  async llamaSwapStatus() {
    return { managed: false, pid: null, portBusy: false, healthy: false, models: [] }
  },
  async llamaSwapLogs() {
    return []
  },
  async saveLlamaSwapConfig() {
    return { error: SHELL_ONLY }
  },
  async getLlamaSwapConfig() {
    return { models: [], path: null }
  },
  async importLlamaSwapConfig() {
    return { error: SHELL_ONLY }
  },
  async openUrl(url) {
    window.open(url, '_blank')
    return { opened: true }
  },
  async openPath() {
    return { error: 'needs the desktop shell' }
  },
  async downloadAndLaunchInstaller() {
    throw new Error(SHELL_ONLY)
  },
  async onDownloadProgress() {
    return () => {}
  },
}

/**
 * The implementation is resolved PER CALL, not at import time: pywebview
 * injects `window.pywebview.api` asynchronously, so a const bound during
 * module init would race the injection and stick to the browser stub even
 * inside the native window (App waits for the api before the first call).
 */
export const bridge: Bridge = new Proxy({} as Bridge, {
  get(_target, prop) {
    const impl = isPywebview() ? pywebview : browser
    return impl[prop as keyof Bridge]
  },
})
