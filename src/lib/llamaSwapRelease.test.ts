import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_LATEST_URL, fetchLatestRelease, parseAssetName, parseChecksums, parseRelease, pickAsset } from './llamaSwapRelease'

// Real v253 release payload (captured 2026-09-04) — reduced to the fields
// parseRelease reads, with all seven real assets and their real digests.
const asset = (name: string, size: number, digest: string) => ({
  name,
  size,
  digest,
  browser_download_url: `https://github.com/mostlygeek/llama-swap/releases/download/v253/${name}`,
})

const V253 = {
  tag_name: 'v253',
  name: 'v253',
  published_at: '2026-09-04T06:48:59Z',
  assets: [
    asset('llama-swap_253_checksums.txt', 603, 'sha256:5be3aa6d01b29cf03052b6bebe29795934e8f2183b08725f58d17acfdd184a5d'),
    asset('llama-swap_253_windows_amd64.zip', 22732389, 'sha256:7df996210089d17ad32ad1f27ff965d44f22b861b249bc249ed8c86f67b702fa'),
    asset('llama-swap_253_linux_amd64.tar.gz', 22819030, 'sha256:91f4d0af56cd5471d0133d6f89db7a7db118a9cd6f8ecd2bbdffd50aa29e5eb6'),
    asset('llama-swap_253_linux_arm64.tar.gz', 21277991, 'sha256:7ccf4e1920cf36c041e2cabe2388676a4755c9763c396cfb2f9fd46649788a90'),
    asset('llama-swap_253_darwin_amd64.tar.gz', 22704696, 'sha256:6e29560dcde62dd9d3e6758ceb5475398d45e9e30bdff79e295f1cf7a19ba389'),
    asset('llama-swap_253_darwin_arm64.tar.gz', 21711909, 'sha256:979b2d84cc24564892e7ff9581af5277f8254af8884ad78bd5b65bb7985257dc'),
    asset('llama-swap_253_freebsd_amd64.tar.gz', 21832399, 'sha256:a710b9f949490bae604242b28f4cfcb02bc0032e37d942ea57428d878be58d01'),
  ],
}

// Real contents of llama-swap_253_checksums.txt.
const CHECKSUMS = `6e29560dcde62dd9d3e6758ceb5475398d45e9e30bdff79e295f1cf7a19ba389  llama-swap_253_darwin_amd64.tar.gz
979b2d84cc24564892e7ff9581af5277f8254af8884ad78bd5b65bb7985257dc  llama-swap_253_darwin_arm64.tar.gz
a710b9f949490bae604242b28f4cfcb02bc0032e37d942ea57428d878be58d01  llama-swap_253_freebsd_amd64.tar.gz
91f4d0af56cd5471d0133d6f89db7a7db118a9cd6f8ecd2bbdffd50aa29e5eb6  llama-swap_253_linux_amd64.tar.gz
7ccf4e1920cf36c041e2cabe2388676a4755c9763c396cfb2f9fd46649788a90  llama-swap_253_linux_arm64.tar.gz
7df996210089d17ad32ad1f27ff965d44f22b861b249bc249ed8c86f67b702fa  llama-swap_253_windows_amd64.zip
`

describe('parseAssetName', () => {
  it('parses a windows zip', () => {
    expect(parseAssetName('llama-swap_253_windows_amd64.zip')).toEqual({
      version: 253,
      os: 'windows',
      arch: 'amd64',
      ext: 'zip',
    })
  })

  it('parses a linux tar.gz', () => {
    expect(parseAssetName('llama-swap_253_linux_arm64.tar.gz')).toEqual({
      version: 253,
      os: 'linux',
      arch: 'arm64',
      ext: 'tar.gz',
    })
  })

  it('rejects the checksums file and unknown names', () => {
    expect(parseAssetName('llama-swap_253_checksums.txt')).toBeNull()
    expect(parseAssetName('llama-swap_253_windows_amd64.deb')).toBeNull()
    expect(parseAssetName('llama-swap_253_windows_arm32.zip')).toBeNull()
    expect(parseAssetName('llama-swap_latest_windows_amd64.zip')).toBeNull()
  })
})

describe('parseRelease', () => {
  it('parses the real v253 payload', () => {
    const rel = parseRelease(V253)
    expect(rel.tag).toBe('v253')
    expect(rel.version).toBe(253)
    expect(rel.publishedAt).toBe('2026-09-04T06:48:59Z')
    expect(rel.assets).toHaveLength(6)
    expect(rel.checksumsUrl).toContain('llama-swap_253_checksums.txt')
    const win = rel.assets.find((a) => a.os === 'windows')
    expect(win?.ext).toBe('zip')
    expect(win?.sha256).toBe('7df996210089d17ad32ad1f27ff965d44f22b861b249bc249ed8c86f67b702fa')
    expect(win?.sizeBytes).toBe(22732389)
  })

  it('throws on a bad tag', () => {
    expect(() => parseRelease({ ...V253, tag_name: '253' })).toThrow(/bad tag/)
    expect(() => parseRelease({ ...V253, tag_name: 'vX' })).toThrow(/bad tag/)
    expect(() => parseRelease({ ...V253, tag_name: undefined })).toThrow(/bad tag/)
  })

  it('throws when nothing is usable', () => {
    expect(() => parseRelease({ tag_name: 'v1', assets: [] })).toThrow(/no usable assets/)
    expect(() => parseRelease({ tag_name: 'v1', assets: [{ name: 'notes.txt' }] })).toThrow(/no usable assets/)
  })

  it('throws on a non-object payload', () => {
    expect(() => parseRelease(null)).toThrow(/not an object/)
    expect(() => parseRelease('v253')).toThrow(/not an object/)
  })

  it('ignores assets without a download url', () => {
    const rel = parseRelease({
      tag_name: 'v253',
      assets: [
        { name: 'llama-swap_253_linux_amd64.tar.gz' }, // no url → skipped
        asset('llama-swap_253_windows_amd64.zip', 1, 'sha256:7df996210089d17ad32ad1f27ff965d44f22b861b249bc249ed8c86f67b702fa'),
      ],
    })
    expect(rel.assets).toHaveLength(1)
    expect(rel.assets[0].name).toBe('llama-swap_253_windows_amd64.zip')
  })
})

describe('pickAsset', () => {
  const rel = parseRelease(V253)

  it('maps user-facing os/arch to release assets', () => {
    expect(pickAsset(rel, 'win', 'x64')?.name).toBe('llama-swap_253_windows_amd64.zip')
    expect(pickAsset(rel, 'linux', 'x64')?.name).toBe('llama-swap_253_linux_amd64.tar.gz')
    expect(pickAsset(rel, 'linux', 'arm64')?.name).toBe('llama-swap_253_linux_arm64.tar.gz')
    expect(pickAsset(rel, 'macos', 'arm64')?.name).toBe('llama-swap_253_darwin_arm64.tar.gz')
    expect(pickAsset(rel, 'macos', 'x64')?.name).toBe('llama-swap_253_darwin_amd64.tar.gz')
  })

  it('returns null for a missing combo', () => {
    expect(pickAsset(rel, 'win', 'arm64')).toBeNull()
  })
})

describe('parseChecksums', () => {
  it('parses the real v253 checksums file', () => {
    const m = parseChecksums(CHECKSUMS)
    expect(Object.keys(m)).toHaveLength(6)
    expect(m['llama-swap_253_windows_amd64.zip']).toBe('7df996210089d17ad32ad1f27ff965d44f22b861b249bc249ed8c86f67b702fa')
    expect(m['llama-swap_253_linux_arm64.tar.gz']).toBe('7ccf4e1920cf36c041e2cabe2388676a4755c9763c396cfb2f9fd46649788a90')
  })

  it('matches the API digest against the checksums file', () => {
    const rel = parseRelease(V253)
    const m = parseChecksums(CHECKSUMS)
    for (const a of rel.assets) {
      expect(m[a.name], a.name).toBe(a.sha256)
    }
  })

  it('ignores blank lines and comments', () => {
    expect(parseChecksums('\n# comment\n   \n')).toEqual({})
  })
})

describe('fetchLatestRelease', () => {
  let server: Server

  afterEach(async () => {
    if (server) await new Promise((r) => server.close(r))
  })

  const serve = (body: unknown, status = 200) =>
    new Promise<string>((resolve) => {
      server = createServer((_req, res) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      })
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        const port = typeof addr === 'object' && addr !== null ? addr.port : 0
        resolve(`http://127.0.0.1:${port}/releases/latest`)
      })
    })

  it('fetches and parses from a mock server', async () => {
    const url = await serve(V253)
    const rel = await fetchLatestRelease(url)
    expect(rel.version).toBe(253)
    expect(rel.assets).toHaveLength(6)
    expect(rel.checksumsUrl).toContain('v253')
  })

  it('throws on an HTTP error', async () => {
    const url = await serve({ message: 'Not Found' }, 404)
    await expect(fetchLatestRelease(url)).rejects.toThrow(/HTTP 404/)
  })

  it('throws on a malformed payload', async () => {
    const url = await serve({ tag_name: 'nope', assets: [] })
    await expect(fetchLatestRelease(url)).rejects.toThrow(/bad tag/)
  })

  it('defaults to the GitHub API', () => {
    expect(DEFAULT_LATEST_URL).toBe('https://api.github.com/repos/mostlygeek/llama-swap/releases/latest')
  })
})
