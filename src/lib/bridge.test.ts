import { afterEach, describe, expect, it } from 'vitest'
import { bridge, isPywebview } from './bridge'
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
            return false
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
    expect(await bridge.stopLlamaSwap()).toBe(false)
    expect(calls).toEqual(
      expect.arrayContaining(['save_config', 'download_and_stage', 'swap_component', 'list_backups', 'probe_port']),
    )
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
