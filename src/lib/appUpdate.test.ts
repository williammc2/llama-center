import { describe, it, expect, vi } from 'vitest'
import { parseAppRelease, compareVersions, checkAppUpdate } from './appUpdate'

describe('parseAppRelease', () => {
  it('parses a valid release payload (Windows)', () => {
    const orig = Object.getOwnPropertyDescriptor(navigator, 'platform')
    Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true })
    try {
      const raw = {
        tag_name: 'v0.2.0',
        name: 'v0.2.0',
        body: '### Features\n- new thing',
        published_at: '2026-09-05T12:00:00Z',
        assets: [
          { name: 'llama-center-setup-0.2.0.exe', browser_download_url: 'https://github.com/x/releases/download/v0.2.0/llama-center-setup-0.2.0.exe' },
          { name: 'llama-center-0.2.0-linux-x86_64.tar.gz', browser_download_url: 'https://github.com/x/releases/download/v0.2.0/llama-center-linux.tar.gz' },
        ],
      }
      const rel = parseAppRelease(raw)
      expect(rel.version).toBe('0.2.0')
      expect(rel.tag).toBe('v0.2.0')
      expect(rel.notes).toContain('new thing')
      expect(rel.installerUrl).toContain('.exe')
      expect(rel.publishedAt).toBe('2026-09-05T12:00:00Z')
    } finally {
      if (orig) Object.defineProperty(navigator, 'platform', orig)
    }
  })

  it('selects .tar.gz on Linux platform', () => {
    const origPlatform = Object.getOwnPropertyDescriptor(navigator, 'platform')
    Object.defineProperty(navigator, 'platform', { value: 'Linux x86_64', configurable: true })
    try {
      const raw = {
        tag_name: 'v0.2.0',
        assets: [
          { name: 'llama-center-setup-0.2.0.exe', browser_download_url: 'https://x/setup.exe' },
          { name: 'llama-center-0.2.0-linux-x86_64.tar.gz', browser_download_url: 'https://x/linux.tar.gz' },
        ],
      }
      const rel = parseAppRelease(raw)
      expect(rel.installerUrl).toBe('https://x/linux.tar.gz')
    } finally {
      if (origPlatform) Object.defineProperty(navigator, 'platform', origPlatform)
    }
  })

  it('handles missing body and assets', () => {
    const raw = { tag_name: 'v1.0.0', body: null, assets: [] }
    const rel = parseAppRelease(raw)
    expect(rel.version).toBe('1.0.0')
    expect(rel.notes).toBe('')
    expect(rel.installerUrl).toBeNull()
  })

  it('throws on non-object', () => {
    expect(() => parseAppRelease(null)).toThrow('not an object')
    expect(() => parseAppRelease('hello')).toThrow('not an object')
  })

  it('throws on bad tag', () => {
    expect(() => parseAppRelease({ tag_name: 'nope' })).toThrow('bad tag')
    expect(() => parseAppRelease({ tag_name: 'v1.2' })).toThrow('bad tag')
  })
})

describe('compareVersions', () => {
  it('equal versions return 0', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
  })

  it('higher major wins', () => {
    expect(compareVersions('2.0.0', '1.9.9')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0', '2.0.0')).toBeLessThan(0)
  })

  it('higher minor wins', () => {
    expect(compareVersions('1.3.0', '1.2.9')).toBeGreaterThan(0)
  })

  it('higher patch wins', () => {
    expect(compareVersions('1.2.4', '1.2.3')).toBeGreaterThan(0)
  })
})

describe('checkAppUpdate', () => {
  const mockRelease = {
    tag_name: 'v0.2.0',
    body: '### Fixes\n- bug fix',
    published_at: '2026-09-05T12:00:00Z',
    assets: [
      { name: 'llama-center-setup-0.2.0.exe', browser_download_url: 'https://example.com/setup.exe' },
    ],
  }

  it('returns release when newer version available', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockRelease,
    })
    const result = await checkAppUpdate('0.1.0', fetchMock as typeof fetch)
    expect(result).not.toBeNull()
    expect(result!.version).toBe('0.2.0')
  })

  it('returns null when up-to-date', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockRelease,
    })
    const result = await checkAppUpdate('0.2.0', fetchMock as typeof fetch)
    expect(result).toBeNull()
  })

  it('returns null when current is newer', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockRelease,
    })
    const result = await checkAppUpdate('0.3.0', fetchMock as typeof fetch)
    expect(result).toBeNull()
  })

  it('throws on HTTP error', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404 })
    await expect(checkAppUpdate('0.1.0', fetchMock as typeof fetch)).rejects.toThrow('HTTP 404')
  })
})
