import { describe, it, expect } from 'vitest'
import { parseConfig, serializeConfig, DEFAULT_CONFIG } from './config'

describe('parseConfig', () => {
  it('accepts a valid full config', () => {
    const cfg = parseConfig({
      version: 1,
      firstRunDone: true,
      installDir: 'C:\\Users\\willi\\AppData\\Local\\llama-center',
      backend: 'cuda',
      cudaMajor: 13,
      cudaFamily: 'cudart',
      llamaCppPin: 'b10814',
      llamaSwapPort: 8085,
      lang: 'pt-BR',
      startWithSystem: true,
      autoStartLlamaSwap: true,
      closeToTray: false,
      checkUpdatesOnStart: false,
    })
    expect(cfg.backend).toBe('cuda')
    expect(cfg.cudaMajor).toBe(13)
    expect(cfg.lang).toBe('pt-BR')
    expect(cfg.installDir).toContain('llama-center')
  })

  it('fills missing keys with defaults', () => {
    const cfg = parseConfig({ version: 1, installDir: '/x' })
    expect(cfg.llamaSwapPort).toBe(DEFAULT_CONFIG.llamaSwapPort)
    expect(cfg.firstRunDone).toBe(false)
    expect(cfg.backend).toBe('cpu')
    expect(cfg.lang).toBe('en')
    expect(cfg.closeToTray).toBe(true)
  })

  it('drops cudaMajor when not 12/13', () => {
    const cfg = parseConfig({ version: 1, installDir: '/x', backend: 'cuda', cudaMajor: 11 })
    expect(cfg.cudaMajor).toBeUndefined()
  })

  it('rejects unknown version', () => {
    expect(() => parseConfig({ version: 2, installDir: '/x' })).toThrow(/unsupported version/)
  })

  it('rejects non-object', () => {
    expect(() => parseConfig(null)).toThrow(/not an object/)
    expect(() => parseConfig('x')).toThrow(/not an object/)
  })

  it('rejects unknown backend', () => {
    expect(() => parseConfig({ version: 1, installDir: '/x', backend: 'metal' })).toThrow(/unknown backend/)
  })

  it('rejects bad port (non-positive / non-integer)', () => {
    expect(() => parseConfig({ version: 1, installDir: '/x', llamaSwapPort: 0 })).toThrow()
    expect(() => parseConfig({ version: 1, installDir: '/x', llamaSwapPort: 80.5 })).toThrow()
  })

  it('round-trips through serializeConfig', () => {
    const cfg = parseConfig({ version: 1, installDir: '/x', backend: 'cuda', cudaMajor: 12 })
    const json = serializeConfig(cfg)
    expect(json).toBe(JSON.stringify(cfg, null, 2) + '\n')
    expect(parseConfig(JSON.parse(json))).toEqual(cfg)
  })
})
