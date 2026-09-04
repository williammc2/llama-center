import { useCallback, useEffect, useState } from 'react'
import { bridge } from '../lib/bridge'
import type { AppConfig } from '../lib/config'
import type { Detection } from '../lib/detect'
import { fetchLatestRelease, pickAsset, type SwapRelease } from '../lib/llamaSwapRelease'

type Phase =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'downloading'; message?: string }
  | { status: 'installing'; message?: string }
  | { status: 'done'; message: string }
  | { status: 'error'; message: string }

interface HomeProps {
  cfg: AppConfig
  detection: Detection
}

export function Home({ cfg, detection }: HomeProps) {
  const [latest, setLatest] = useState<SwapRelease | null>(null)
  const [phase, setPhase] = useState<Phase>({ status: 'idle' })
  const [portBusy, setPortBusy] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [backups, setBackups] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  const installed = cfg.llamaSwapInstalled

  const refresh = useCallback(async () => {
    const [busyNow, list] = await Promise.all([
      bridge.probePort(cfg.llamaSwapPort),
      bridge.listLlamaSwapBackups(),
    ])
    setPortBusy(busyNow)
    setBackups(list)
  }, [cfg.llamaSwapPort])

  const check = useCallback(async () => {
    setPhase({ status: 'checking' })
    try {
      const rel = await fetchLatestRelease()
      setLatest(rel)
      setPhase({ status: 'idle' })
    } catch (e) {
      setPhase({ status: 'error', message: e instanceof Error ? e.message : 'update check failed' })
    }
  }, [])

  useEffect(() => {
    void refresh()
    if (cfg.checkUpdatesOnStart) void check()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const updateLabel = !latest
    ? null
    : installed === null
      ? 'Install llama-swap'
      : latest.version > installed
        ? `Update to v${latest.version}`
        : null

  const runUpdate = async (adopt: boolean) => {
    if (!latest) return
    const os = detection.os === 'unknown' ? null : detection.os
    const arch = detection.arch === 'unknown' ? null : detection.arch
    setConflict(false)
    if (!os || !arch) {
      setPhase({ status: 'error', message: 'OS/arch not detected — re-run the wizard' })
      return
    }
    const asset = pickAsset(latest, os, arch)
    if (!asset) {
      setPhase({ status: 'error', message: `no llama-swap asset for ${os} ${arch}` })
      return
    }
    setBusy(true)
    try {
      if (portBusy && !adopt) {
        setPhase({ status: 'installing', message: 'stopping llama-swap…' })
        await bridge.stopLlamaSwap()
      }
      setPhase({ status: 'downloading', message: `downloading ${asset.name}…` })
      await bridge.downloadAndStage(asset.url, asset.sha256)
      setPhase({ status: 'installing', message: 'installing…' })
      const backup = await bridge.swapLlamaSwap()
      await bridge.saveConfig({ ...cfg, llamaSwapInstalled: latest.version })
      setPhase({
        status: 'done',
        message: backup ? 'done — previous install kept as a backup (rollback available)' : 'installed',
      })
      await refresh()
    } catch (e) {
      setPhase({ status: 'error', message: e instanceof Error ? e.message : 'update failed' })
    } finally {
      setBusy(false)
    }
  }

  const startUpdate = async () => {
    if (!latest) return
    if (portBusy) {
      setConflict(true)
      return
    }
    await runUpdate(false)
  }

  const doRollback = async () => {
    if (backups.length === 0) return
    setBusy(true)
    try {
      const ok = await bridge.rollbackLlamaSwap()
      if (!ok) {
        setPhase({ status: 'error', message: 'no backups to roll back to' })
        return
      }
      const m = /v(\d+)/.exec(backups[0])
      if (m) await bridge.saveConfig({ ...cfg, llamaSwapInstalled: Number(m[1]) })
      setPhase({ status: 'done', message: `rolled back to ${backups[0]}` })
      await refresh()
    } catch (e) {
      setPhase({ status: 'error', message: e instanceof Error ? e.message : 'rollback failed' })
    } finally {
      setBusy(false)
    }
  }

  const upToDate = latest !== null && installed !== null && latest.version <= installed
  const busyAny = busy || phase.status === 'checking' || phase.status === 'downloading' || phase.status === 'installing'
  const phaseLine =
    phase.status === 'downloading' || phase.status === 'installing' ? phase.message ?? null : null

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">llama-center</h1>
        <p className="mt-1 text-sm text-neutral-500">
          backend <span className="font-mono text-neutral-400">{cfg.backend}</span> · port{' '}
          <span className="font-mono text-neutral-400">{cfg.llamaSwapPort}</span>
        </p>
      </header>

      <section className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-neutral-300">llama-swap</h2>
          <span
            className={
              'rounded-full px-2 py-0.5 text-xs ' +
              (portBusy ? 'bg-amber-500/15 text-amber-400' : 'bg-neutral-800 text-neutral-500')
            }
          >
            {portBusy ? 'port in use' : 'port free'}
          </span>
        </div>

        <dl className="mt-3 space-y-1 text-sm">
          <div className="flex justify-between">
            <dt className="text-neutral-500">installed</dt>
            <dd className="font-mono text-neutral-200">{installed === null ? '—' : `v${installed}`}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-neutral-500">latest</dt>
            <dd className="font-mono text-neutral-200">{latest ? `v${latest.version}` : 'not checked'}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-neutral-500">backups</dt>
            <dd className="font-mono text-neutral-200">{backups.length}</dd>
          </div>
        </dl>

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void check()}
            disabled={busyAny}
            className="rounded-md border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 transition-colors hover:border-neutral-500 disabled:opacity-50"
          >
            {phase.status === 'checking' ? 'Checking…' : 'Check for updates'}
          </button>
          {updateLabel && (
            <button
              type="button"
              onClick={() => void startUpdate()}
              disabled={busyAny}
              className="rounded-md bg-sky-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-sky-500 disabled:cursor-wait disabled:opacity-60"
            >
              {updateLabel}
            </button>
          )}
          {backups.length > 0 && (
            <button
              type="button"
              onClick={() => void doRollback()}
              disabled={busyAny}
              className="rounded-md border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 transition-colors hover:border-neutral-500 disabled:opacity-50"
            >
              Rollback
            </button>
          )}
        </div>

        {upToDate && latest && <p className="mt-3 text-xs text-emerald-600">Up to date (v{installed}).</p>}
        {phaseLine && <p className="mt-3 text-xs text-neutral-400">{phaseLine}</p>}
        {phase.status === 'done' && <p className="mt-3 text-xs text-emerald-600">{phase.message}</p>}
        {phase.status === 'error' && (
          <p role="alert" className="mt-3 text-xs text-red-400">
            {phase.message}
          </p>
        )}
      </section>

      <section className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-4">
        <h2 className="text-sm font-medium text-neutral-300">llama.cpp</h2>
        <p className="mt-2 text-sm text-neutral-500">Nightly discovery + install lands in P2.</p>
      </section>

      {conflict && (
        <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/60 px-4">
          <div className="w-full max-w-md rounded-lg border border-neutral-700 bg-neutral-900 p-5">
            <h3 className="text-sm font-medium text-neutral-200">Port {cfg.llamaSwapPort} is in use</h3>
            <p className="mt-2 text-sm text-neutral-400">
              Something is already listening — likely a llama-swap started outside this app.
            </p>
            <div className="mt-4 flex flex-col gap-2">
              <button
                type="button"
                onClick={() => void runUpdate(false)}
                className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-500"
              >
                Stop & take over
              </button>
              <button
                type="button"
                onClick={() => void runUpdate(true)}
                className="rounded-md border border-neutral-700 px-4 py-2 text-sm text-neutral-300 transition-colors hover:border-neutral-500"
              >
                Adopt (update without stopping)
              </button>
              <button
                type="button"
                onClick={() => setConflict(false)}
                className="rounded-md border border-neutral-700 px-4 py-2 text-sm text-neutral-300 transition-colors hover:border-neutral-500"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
