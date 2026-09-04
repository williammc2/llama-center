import { useMemo, useState } from 'react'
import type { Backend } from '../lib/assetResolver'
import { resolve } from '../lib/assetResolver'
import { bridge } from '../lib/bridge'
import type { AppConfig, Lang } from '../lib/config'
import { DEFAULT_CONFIG } from '../lib/config'
import type { Detection } from '../lib/detect'

interface WizardProps {
  detection: Detection
  onSaved: (cfg: AppConfig) => void
}

const DEFAULT_DIR: Record<string, string> = {
  win: '%LOCALAPPDATA%\\llama-center',
  linux: '~/.local/share/llama-center',
  macos: '~/Library/Application Support/llama-center',
}

const BACKEND_LABEL: Record<Backend, string> = {
  cpu: 'CPU',
  cuda: 'CUDA (NVIDIA)',
  vulkan: 'Vulkan',
  rocm: 'ROCm (AMD)',
  sycl: 'SYCL (Intel)',
  openvino: 'OpenVINO',
  opencl: 'OpenCL',
}

export function Wizard({ detection, onSaved }: WizardProps) {
  const [backend, setBackend] = useState<Backend>(detection.suggestCuda ? 'cuda' : 'cpu')
  const [cudaMajor, setCudaMajor] = useState<12 | 13>(13)
  const [cudaFamily, setCudaFamily] = useState<'cudart' | 'plain'>('cudart')
  const [installDir, setInstallDir] = useState(DEFAULT_DIR[detection.os] ?? '')
  const [port, setPort] = useState(DEFAULT_CONFIG.llamaSwapPort)
  const [lang, setLang] = useState<Lang>('en')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const os = detection.os
  const arch = detection.arch

  const finish = async () => {
    if (!installDir.trim()) {
      setError('Install directory is required.')
      return
    }
    if (port < 1 || port > 65535) {
      setError('Port must be between 1 and 65535.')
      return
    }
    const cfg: AppConfig = {
      ...DEFAULT_CONFIG,
      firstRunDone: true,
      installDir: installDir.trim(),
      backend,
      cudaMajor: backend === 'cuda' ? cudaMajor : undefined,
      cudaFamily: backend === 'cuda' ? cudaFamily : undefined,
      llamaSwapPort: port,
      lang,
    }
    setSaving(true)
    setError(null)
    try {
      // Bridge picks the real implementation: pywebview (fs write) or
      // browser (localStorage) — the wizard doesn't care which.
      await bridge.saveConfig(cfg)
      onSaved(cfg)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save config')
      setSaving(false)
    }
  }

  const detectedLine = useMemo(() => {
    if (os === 'unknown') return 'OS not detected — pick a backend manually.'
    return `${os === 'linux' ? 'Linux' : os === 'win' ? 'Windows' : 'macOS'} · ${arch === 'unknown' ? 'arch unknown' : arch}`
  }, [os, arch])

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">llama-center</h1>
        <p className="mt-1 text-sm text-neutral-500">
          First run — set up llama.cpp + llama-swap. Detected: <span className="font-mono text-neutral-400">{detectedLine}</span>
        </p>
        {detection.suggestCuda && (
          <p className="mt-1 text-sm text-emerald-600">NVIDIA GPU detected — CUDA pre-selected.</p>
        )}
      </header>

      <section className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-4">
        <h2 className="text-sm font-medium text-neutral-300">Backend</h2>
        <div className="mt-3 grid grid-cols-2 gap-2">
          {detection.backends.map((b) => (
            <button
              key={b}
              type="button"
              onClick={() => setBackend(b)}
              className={
                'rounded-md border px-3 py-2 text-left text-sm transition-colors ' +
                (backend === b
                  ? 'border-sky-500 bg-sky-500/10 text-sky-300'
                  : 'border-neutral-700 text-neutral-300 hover:border-neutral-500')
              }
            >
              {BACKEND_LABEL[b]}
            </button>
          ))}
        </div>

        {backend === 'cuda' && (
          <div className="mt-4 grid grid-cols-2 gap-4">
            <label className="flex flex-col gap-1 text-xs text-neutral-400">
              CUDA major
              <select
                value={cudaMajor}
                onChange={(e) => setCudaMajor(Number(e.target.value) as 12 | 13)}
                className="rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-200"
              >
                <option value={13}>13 (latest)</option>
                <option value={12}>12</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-neutral-400">
              Build family
              <select
                value={cudaFamily}
                onChange={(e) => setCudaFamily(e.target.value as 'cudart' | 'plain')}
                className="rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-200"
              >
                <option value="cudart">cudart (self-contained, ~1.5× larger)</option>
                <option value="plain">plain (needs CUDA toolkit installed)</option>
              </select>
            </label>
          </div>
        )}
      </section>

      <section className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-4">
        <h2 className="text-sm font-medium text-neutral-300">Installation</h2>
        <label className="mt-3 flex flex-col gap-1 text-xs text-neutral-400">
          Install directory
          <input
            value={installDir}
            onChange={(e) => setInstallDir(e.target.value)}
            className="rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5 font-mono text-sm text-neutral-200"
            spellCheck={false}
          />
        </label>
        <div className="mt-3 grid grid-cols-2 gap-4">
          <label className="flex flex-col gap-1 text-xs text-neutral-400">
            llama-swap port
            <input
              type="number"
              min={1}
              max={65535}
              value={port}
              onChange={(e) => setPort(Number(e.target.value))}
              className="rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-200"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-400">
            Language
            <select
              value={lang}
              onChange={(e) => setLang(e.target.value as Lang)}
              className="rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-200"
            >
              <option value="en">English</option>
              <option value="pt-BR">Português (BR)</option>
            </select>
          </label>
        </div>
      </section>

      {error && (
        <p role="alert" className="rounded-md border border-red-800 bg-red-950/50 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={finish}
          disabled={saving}
          className="rounded-md bg-sky-600 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-500 disabled:cursor-wait disabled:opacity-60"
        >
          {saving ? 'Saving…' : 'Save & continue'}
        </button>
      </div>
    </div>
  )
}

/**
 * Preview of what the resolver will actually download for the current
 * selection — shown after the wizard so the user sees the real asset name
 * before any bytes move. Returns null until a nightly's assets are fetched
 * (P1/P2), so the wizard never blocks on the network.
 */
export function resolvePreview(
  assets: Parameters<typeof resolve>[0],
  cfg: AppConfig,
  os: 'win' | 'linux' | 'macos',
  arch: 'x64' | 'arm64',
): { assetName: string; fellBack: boolean; reason?: string } | null {
  const r = resolve(assets, {
    os,
    arch,
    backend: cfg.backend,
    cudaMajor: cfg.cudaMajor,
    family: cfg.cudaFamily,
  })
  if (r.status !== 'ok') return null
  return { assetName: r.asset.name, fellBack: r.fellBack, reason: r.reason }
}
