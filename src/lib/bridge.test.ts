import { afterEach, describe, expect, it } from 'vitest'
import { bridge, isApiReady, isPywebview } from './bridge'
import { DEFAULT_CONFIG } from './config'

const g = globalThis as unknown as {
  window?: unknown
  localStorage?: { getItem(k: string): string | null; setItem(k: string, v: string): void }
}

afterEach(() => {
  delete g.window
  delete g.localStorage
})

describe('bridge — lazy shell resolution', () => {
  it('resolves to pywebview once the api is injected, even if the module loaded first', async () => {
    // The module was imported while the api was absent — inside the native
    // window pywebview injects `window.pywebview.api` asynchronously, AFTER
    // the page bundle runs. A const bound at import time would stick to the
    // browser stub forever (the bug this guards against).
    expect(isPywebview()).toBe(false)

    const calls: string[] = []
    g.window = {
      pywebview: {
        api: {
          get_detection: async () => ({
            os: 'win',
            arch: 'x64',
            suggestCuda: false,
            cudaMajorHint: null,
            gpuName: null,
            backends: ['cpu', 'cuda'],
          }),
          get_config: async () => null,
          save_config: async () => {
            calls.push('save_config')
            return { path: 'C:\\fake\\config.json' }
          },
          download_and_stage: async (_component: string, _url: string, _sha: string | null, _into?: string) => {
            calls.push('download_and_stage')
            return { staging: 'C:\\fake\\staging' }
          },
          swap_component: async (_component: string) => {
            calls.push('swap_component')
            return { backup: null }
          },
          rollback_component: async (_component: string) => {
            calls.push('rollback_component')
            return { rolledBack: false }
          },
          list_component_backups: async (_component: string) => {
            calls.push('list_backups')
            return []
          },
          probe_port: async () => {
            calls.push('probe_port')
            return false
          },
          stop_llama_swap: async () => {
            calls.push('stop_llama_swap')
            return { stopped: false, exitCode: null }
          },
          start_llama_swap: async () => {
            calls.push('start_llama_swap')
            return { pid: 42 }
          },
          llama_swap_status: async () => {
            calls.push('llama_swap_status')
            return { managed: false, pid: null, portBusy: false, healthy: false, models: [] }
          },
          llama_swap_logs: async () => {
            calls.push('llama_swap_logs')
            return []
          },
        },
      },
    }
    expect(isPywebview()).toBe(true)

    // Every call now reaches the Python api, not localStorage.
    const path = await bridge.saveConfig(DEFAULT_CONFIG)
    expect(path).toBe('C:\\fake\\config.json')
    expect(calls).toContain('save_config')
    expect(await bridge.getConfig()).toBeNull()
    expect(await bridge.downloadAndStage('llama-swap', 'http://x/y.zip', null)).toBe('C:\\fake\\staging')
    expect(await bridge.swapComponent('llama-swap')).toBeNull()
    expect(await bridge.rollbackComponent('llama-cpp')).toBe(false)
    expect(await bridge.listComponentBackups('llama-swap')).toEqual([])
    expect(await bridge.probePort(8085)).toBe(false)
    expect(await bridge.stopLlamaSwap()).toEqual({ stopped: false, exitCode: null })
    expect(await bridge.startLlamaSwap()).toEqual({ pid: 42 })
    expect(await bridge.llamaSwapStatus()).toEqual({
      managed: false,
      pid: null,
      portBusy: false,
      healthy: false,
      models: [],
    })
    expect(await bridge.llamaSwapLogs()).toEqual([])

    // progress pushes: Python calls window.__lcProgress, which is our callback
    const off = await bridge.onDownloadProgress((p) => calls.push(`progress:${p.received}`))
    const w = g.window as { __lcProgress?: (p: { received: number }) => void }
    expect(typeof w.__lcProgress).toBe('function')
    w.__lcProgress!({ received: 5 })
    expect(calls).toContain('progress:5')
    off()
    expect(w.__lcProgress).toBeUndefined()
    expect(calls).toEqual(
      expect.arrayContaining(['save_config', 'download_and_stage', 'swap_component', 'list_backups', 'probe_port']),
    )
  })

  it('progress fans out to ALL subscribers (not just the last one)', async () => {
    // Regression: onDownloadProgress used to be a single slot — the second
    // subscriber overwrote the first, and an unmount could delete the slot
    // under the others (the Shell's installer progress died after the first
    // page switch). Now every active subscriber receives the push.
    g.window = { pywebview: { api: { get_config: async () => null } } }
    const a: number[] = []
    const b: number[] = []
    const offA = await bridge.onDownloadProgress((p) => a.push(p.received))
    const offB = await bridge.onDownloadProgress((p) => b.push(p.received))

    const w = g.window as { __lcProgress?: (p: { received: number }) => void }
    w.__lcProgress!({ received: 1 })
    expect(a).toEqual([1])
    expect(b).toEqual([1])

    // Unsubscribing one leaves the other (and the slot) intact.
    offA()
    w.__lcProgress!({ received: 2 })
    expect(a).toEqual([1])
    expect(b).toEqual([1, 2])
    expect(typeof w.__lcProgress).toBe('function')

    // Last subscriber leaves → the slot is removed.
    offB()
    expect(w.__lcProgress).toBeUndefined()
  })

  it('resolves to the browser stub when the api never arrives', async () => {
    g.window = {}
    const store: Record<string, string> = {}
    g.localStorage = {
      getItem: (k) => store[k] ?? null,
      setItem: (k, v) => {
        store[k] = v
      },
    }
    expect(isPywebview()).toBe(false)
    expect(await bridge.getConfig()).toBeNull()
    await bridge.saveConfig(DEFAULT_CONFIG)
    expect(store['llama-center:config']).toBeTruthy()
  })
})

describe('isApiReady — the two-step injection gap', () => {
  it('is false when window is absent (bare browser / pnpm dev)', () => {
    expect(isApiReady()).toBe(false)
  })

  it('is false for the EMPTY api object (the gap state that broke post-update boot)', () => {
    // pywebview 6.x: api.js lands first with `api: {}`, finish.js fills the
    // functions later. The old `api !== undefined` check passed HERE, so the
    // first get_config() threw `not a function` and the app sat on
    // "Loading…" forever. isApiReady must reject the empty object.
    g.window = { pywebview: { api: {} } }
    expect(isPywebview()).toBe(true) // the old check would have stopped waiting
    expect(isApiReady()).toBe(false)
  })

  it('is true once the api is populated', () => {
    g.window = { pywebview: { api: { get_config: async () => null } } }
    expect(isApiReady()).toBe(true)
  })

  it('is false when pywebview exists but api is missing', () => {
    g.window = { pywebview: {} }
    expect(isApiReady()).toBe(false)
  })
})
