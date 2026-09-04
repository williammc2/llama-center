import { describe, it, expect } from 'vitest'
import { detect, detectOs, detectArch } from './detect'

describe('detectOs', () => {
  it('windows', () => {
    expect(detectOs('Win32', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('win')
  })
  it('linux', () => {
    expect(detectOs('Linux x86_64', 'Mozilla/5.0 (X11; Linux x86_64)')).toBe('linux')
  })
  it('macos', () => {
    expect(detectOs('MacIntel', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('macos')
  })
  it('unknown', () => {
    expect(detectOs('', '')).toBe('unknown')
  })
})

describe('detectArch', () => {
  it('x64', () => {
    expect(detectArch('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('x64')
  })
  it('arm64', () => {
    expect(detectArch('Mozilla/5.0 (Windows NT 10.0; ARM64)')).toBe('arm64')
    expect(detectArch('Mozilla/5.0 (X11; Linux aarch64)')).toBe('arm64')
  })
  it('unknown', () => {
    expect(detectArch('')).toBe('unknown')
  })
})

describe('detect (full)', () => {
  it('windows + nvidia → offers cuda and suggests it', () => {
    const d = detect({ platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', nvidiaPresent: true })
    expect(d.os).toBe('win')
    expect(d.arch).toBe('x64')
    expect(d.backends).toContain('cuda')
    expect(d.suggestCuda).toBe(true)
  })

  it('linux → backend matrix has NO cuda, suggestCuda stays false even with GPU', () => {
    const d = detect({ platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', nvidiaPresent: true })
    expect(d.backends).not.toContain('cuda')
    expect(d.suggestCuda).toBe(false)
  })

  it('windows without GPU → cuda still offered (user can pick), not auto-suggested', () => {
    const d = detect({ platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })
    expect(d.backends).toContain('cuda')
    expect(d.suggestCuda).toBe(false)
  })

  it('unknown OS → empty backend list (wizard falls back to manual)', () => {
    const d = detect({ platform: '', userAgent: '' })
    expect(d.backends).toEqual([])
    expect(d.suggestCuda).toBe(false)
  })
})
