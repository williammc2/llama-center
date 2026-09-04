import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { assetMeta, checkNightly, parseBuild, requestFromConfig } from './llamaCppNightly'

// Real b10816 release payload (captured 2026-09-04) — subset of the 27 real
// assets with real sizes + digests, plus the non-binary assets to prove
// parseAssets drops them.
const a = (name: string, size: number, digest: string) => ({
  name,
  size,
  digest,
  browser_download_url: `https://github.com/ggml-org/llama.cpp/releases/download/b10816/${name}`,
})

const B10816 = {
  tag_name: 'b10816',
  assets: [
    a('cudart-llama-bin-win-cuda-12.4-x64.zip', 391443627, 'sha256:8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6'),
    a('cudart-llama-bin-win-cuda-13.3-x64.zip', 390970417, 'sha256:1462a050eb4c684921ba51dcc4cc488a036674c3e73e9945ee705b854808d03e'),
    a('cudart-llama-bin-win-cuda-13.4-arm64.zip', 153318797, 'sha256:5a40dc7c5fa3d0a80ceeba4f16f9e8d25d87bcf1399c9233588953c43436c33c'),
    a('llama-b10816-bin-win-cpu-x64.zip', 18412922, 'sha256:b25d1044a9d6061129ce6f3439697b04996c63b9bdccf025a24a10d6d4954766'),
    a('llama-b10816-bin-win-cuda-12.4-x64.zip', 253942297, 'sha256:f567f273ef0cad7aa1835c94426aa38577df16ddd1d32f5085e1a503ae106697'),
    a('llama-b10816-bin-win-cuda-13.3-x64.zip', 149564704, 'sha256:f362882b139862e04714cce6ecb886ab82e256bdd0717c6010f24082fd340c57'),
    a('llama-b10816-bin-win-vulkan-x64.zip', 35228033, 'sha256:ea6704bd058cb37c3d960913637b74bda90e433fc8c1565bc0ff767bec8a25'),
    a('llama-b10816-bin-ubuntu-x64.tar.gz', 16743750, 'sha256:b00b47d0fc4398527181c4f39fcd0afde7b96fbcb748b2073f048f5a3474aa78'),
    a('llama-b10816-ui.tar.gz', 3084722, 'sha256:6af8da21494922efa2459a8758443b74bda90e433fc8c1565bc0ff767bec8a25'),
    a('llama-b10816-xcframework.zip', 86719294, 'sha256:53e60631e8744bf4b1de5ea038cf3fb9edfc50802fc9fc1737748362f27c2651'),
  ],
}

// b10814 — same combos as b10816 PLUS a win-rocm build that b10816 lacks,
// which exercises the newest→oldest walk (skip b10816, land on b10814).
const b = (name: string, sizeMB: number) => ({
  name,
  size: sizeMB * 1024 * 1024,
  digest: `sha256:${'0'.repeat(64)}`,
  browser_download_url: `https://github.com/ggml-org/llama.cpp/releases/download/b10814/${name}`,
})

const B10814 = {
  tag_name: 'b10814',
  assets: [
    b('cudart-llama-bin-win-cuda-12.4-x64.zip', 373),
    b('cudart-llama-bin-win-cuda-13.3-x64.zip', 372),
    b('llama-b10814-bin-win-cpu-x64.zip', 17),
    b('llama-b10814-bin-win-cuda-12.4-x64.zip', 242),
    b('llama-b10814-bin-win-cuda-13.3-x64.zip', 142),
    b('llama-b10814-bin-win-rocm-10.0-x64.zip', 232),
  ],
}

// The old stable stub that the API lists before the nightlies.
const V040 = { tag_name: 'v0.4.0', assets: [{ name: 'nightly-tag.txt', size: 7 }] }

describe('parseBuild', () => {
  it('parses a real nightly, dropping non-binary assets', () => {
    const build = parseBuild(B10816)
    expect(build?.info.tag).toBe('b10816')
    expect(build?.rawAssets).toHaveLength(10)
    // ui + xcframework have no `bin` segment → dropped from the resolver view
    expect(build?.info.assets).toHaveLength(8)
    expect(build?.info.assets.some((x) => x.name.includes('xcframework'))).toBe(false)
  })

  it('rejects non-nightly tags and non-objects', () => {
    expect(parseBuild(V040)).toBeNull()
    expect(parseBuild({ tag_name: 'bX', assets: [] })).toBeNull()
    expect(parseBuild(null)).toBeNull()
  })

  it('assetMeta maps a resolved name back to url + sha256', () => {
    const build = parseBuild(B10816)!
    const meta = assetMeta(build, 'cudart-llama-bin-win-cuda-13.3-x64.zip')
    expect(meta?.url).toBe(
      'https://github.com/ggml-org/llama.cpp/releases/download/b10816/cudart-llama-bin-win-cuda-13.3-x64.zip',
    )
    expect(meta?.sha256).toBe('1462a050eb4c684921ba51dcc4cc488a036674c3e73e9945ee705b854808d03e')
    expect(meta?.sizeBytes).toBe(390970417)
    expect(assetMeta(build, 'nope.zip')).toBeNull()
  })
})

describe('checkNightly', () => {
  let server: Server

  afterEach(async () => {
    if (server) await new Promise((r) => server.close(r))
  })

  const serve = (pages: unknown[][]) =>
    new Promise<string>((resolve) => {
      server = createServer((req, res) => {
        const page = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('page') ?? '1')
        const body = pages[page - 1] ?? []
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      })
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        const port = typeof addr === 'object' && addr !== null ? addr.port : 0
        resolve(`http://127.0.0.1:${port}/releases`)
      })
    })

  it('resolves the newest build that has the requested combo', async () => {
    const url = await serve([[V040, B10816, B10814]])
    const check = await checkNightly(
      { os: 'win', arch: 'x64', backend: 'cuda', cudaMajor: 13, family: 'cudart', hardMajor: true },
      30,
      url,
    )
    expect(check.builds.map((x) => x.info.tag)).toEqual(['b10816', 'b10814'])
    expect(check.latest?.build.tag).toBe('b10816')
    expect(check.latest?.isAbsoluteNewest).toBe(true)
    if (check.latest?.resolution.status === 'ok') {
      expect(check.latest.resolution.asset.name).toBe('cudart-llama-bin-win-cuda-13.3-x64.zip')
      const build = check.builds.find((x) => x.info.tag === 'b10816')!
      expect(assetMeta(build, check.latest!.resolution.asset.name)?.sha256).toBe(
        '1462a050eb4c684921ba51dcc4cc488a036674c3e73e9945ee705b854808d03e',
      )
    } else {
      expect.fail('expected an ok resolution')
    }
  })

  it('skips newer builds that lack the combo (walks newest→oldest)', async () => {
    const url = await serve([[V040, B10816, B10814]])
    const check = await checkNightly({ os: 'win', arch: 'x64', backend: 'rocm' }, 30, url)
    expect(check.latest?.build.tag).toBe('b10814') // b10816 has no rocm
    expect(check.latest?.skippedNewer).toBe(1)
    expect(check.latest?.isAbsoluteNewest).toBe(false)
  })

  it('resolves plain cpu builds', async () => {
    const url = await serve([[V040, B10816, B10814]])
    const check = await checkNightly({ os: 'win', arch: 'x64', backend: 'cpu' }, 30, url)
    if (check.latest?.resolution.status === 'ok') {
      expect(check.latest.build.tag).toBe('b10816')
      expect(check.latest.resolution.asset.name).toBe('llama-b10816-bin-win-cpu-x64.zip')
    } else {
      expect.fail('expected an ok resolution')
    }
  })

  it('returns null latest when no build has the combo', async () => {
    const url = await serve([[V040, B10816, B10814]])
    const check = await checkNightly({ os: 'macos', arch: 'arm64', backend: 'rocm' }, 30, url)
    expect(check.latest).toBeNull()
  })

  it('throws on an HTTP error', async () => {
    server = createServer((_req, res) => {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{}')
    })
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
    const addr = server.address()
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0
    await expect(
      checkNightly({ os: 'win', arch: 'x64', backend: 'cpu' }, 5, `http://127.0.0.1:${port}/releases`),
    ).rejects.toThrow(/HTTP 404/)
  })
})

describe('requestFromConfig', () => {
  it('marks the wizard CUDA-major choice as a hard constraint', () => {
    const req = requestFromConfig({ backend: 'cuda', cudaMajor: 13, cudaFamily: 'cudart' }, 'win', 'x64')
    expect(req.hardMajor).toBe(true)
    expect(req.cudaMajor).toBe(13)
  })

  it('no hard constraint for non-cuda backends', () => {
    const req = requestFromConfig({ backend: 'cpu' }, 'linux', 'x64')
    expect(req.hardMajor).toBeFalsy()
  })
})
