import { useEffect, useState } from 'react'
import { bridge, type DownloadProgress } from '../lib/bridge'
import type { AppConfig } from '../lib/config'
import type { Detection } from '../lib/detect'
import { assetMeta, checkNightly, companionAsset, requestFromConfig, type NightlyCheck } from '../lib/llamaCppNightly'

type Phase =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'downloading'; message?: string }
  | { status: 'installing'; message?: string }
  | { status: 'done'; message: string }
  | { status: 'error'; message: string }

interface CppPageProps {
  cfg: AppConfig
  detection: Detection
  onSaveConfig: (next: AppConfig) => Promise<void>
}

export function CppPage({ cfg, detection, onSaveConfig }: CppPageProps) {
  const [cpp, setCpp] = useState<NightlyCheck | null>(null)
  const [phase, setPhase] = useState<Phase>({ status: 'idle' })
  const [backups, setBackups] = useState<string[]>([])
  const [progress, setProgress] = useState<DownloadProgress | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = async () => {
    setBackups(await bridge.listComponentBackups('llama-cpp'))
  }

  const check = async () => {
    if (detection.os === 'unknown' || detection.arch === 'unknown') {
      setPhase({ status: 'error', message: 'OS/arch not detected — re-run the wizard' })
      return
    }
    setPhase({ status: 'checking' })
    try {
      setCpp(await checkNightly(requestFromConfig(cfg, detection.os, detection.arch)))
      setPhase({ status: 'idle' })
    } catch (e) {
      setPhase({ status: 'error', message: e instanceof Error ? e.message : 'update check failed' })
    }
  }

  useEffect(() => {
    void refresh()
    if (cfg.checkUpdatesOnStart) void check()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Tray "Check for updates" lands on the active page.
  useEffect(() => {
    window.__lcCheckUpdates = () => {
      void check()
    }
    return () => {
      delete window.__lcCheckUpdates
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    let off: (() => void) | undefined
    void bridge.onDownloadProgress(setProgress).then((u) => {
      off = u
    })
    return () => {
      off?.()
    }
  }, [])

  const resolution = cpp?.latest?.resolution
  const ok = resolution && resolution.status === 'ok' ? resolution : null
  const assetName = ok?.asset.name ?? null
  const build = cpp?.latest?.build ?? null
  // `latest.build` is one of `cpp.builds` (resolveLatest picks from it).
  const buildParsed = cpp && build ? (cpp.builds.find((x) => x.info.tag === build.tag) ?? null) : null
  const meta = buildParsed && assetName ? assetMeta(buildParsed, assetName) : null
  // Windows CUDA: a second asset (the CUDA runtime DLLs) must be installed
  // alongside the binaries.
  const companion = buildParsed && ok ? companionAsset(buildParsed, ok.asset) : null
  const companionMeta = buildParsed && companion ? assetMeta(buildParsed, companion.name) : null
  const totalMB = meta ? Math.round((meta.sizeBytes + (companionMeta?.sizeBytes ?? 0)) / (1024 * 1024)) : 0

  const updateLabel = !ok
    ? null
    : cfg.llamaCppInstalled === null
      ? 'Install llama.cpp'
      : Number(build!.tag.slice(1)) > Number(cfg.llamaCppInstalled.slice(1))
        ? `Update to ${build!.tag}`
        : null

  const runUpdate = async () => {
    if (!ok || !build || !meta) return
    setBusy(true)
    try {
      setPhase({
        status: 'downloading',
        message: `downloading ${meta.name} (${Math.round(meta.sizeBytes / (1024 * 1024))} MB)…`,
      })
      const staging = await bridge.downloadAndStage('llama-cpp', meta.url, meta.sha256)
      if (companion && companionMeta) {
        setPhase({
          status: 'downloading',
          message: `downloading CUDA ${companion.version} DLLs — ${companionMeta.name} (${Math.round(companionMeta.sizeBytes / (1024 * 1024))} MB)…`,
        })
        await bridge.downloadAndStage('llama-cpp', companionMeta.url, companionMeta.sha256, staging)
      }
      setPhase({ status: 'installing', message: 'installing…' })
      const backup = await bridge.swapComponent('llama-cpp')
      await onSaveConfig({ ...cfg, llamaCppInstalled: build.tag })
      setPhase({
        status: 'done',
        message: backup ? `done — ${backup} kept for rollback` : `installed ${build.tag}`,
      })
      await refresh()
    } catch (e) {
      setPhase({ status: 'error', message: e instanceof Error ? e.message : 'update failed' })
    } finally {
      setBusy(false)
    }
  }

  const doRollback = async () => {
    if (backups.length === 0) return
    setBusy(true)
    try {
      const okRoll = await bridge.rollbackComponent('llama-cpp')
      if (!okRoll) {
        setPhase({ status: 'error', message: 'no backups to roll back to' })
        return
      }
      const m = /b(\d+)/.exec(backups[0])
      if (m) await onSaveConfig({ ...cfg, llamaCppInstalled: `b${m[1]}` })
      setPhase({ status: 'done', message: `rolled back to ${backups[0]}` })
      await refresh()
    } catch (e) {
      setPhase({ status: 'error', message: e instanceof Error ? e.message : 'rollback failed' })
    } finally {
      setBusy(false)
    }
  }

  const busyAny = busy || phase.status === 'checking' || phase.status === 'downloading' || phase.status === 'installing'
  const phaseLine =
    phase.status === 'downloading' || phase.status === 'installing' ? phase.message ?? null : null

  return (
    <>
      <h2 className="text-lg font-semibold text-neutral-100">llama.cpp</h2>
      <p className="mt-1 text-sm text-neutral-500">The inference engine — nightlies, install and updates.</p>

      <section className="mt-4 rounded-lg border border-neutral-800 bg-neutral-900/60 p-4">
        <dl className="space-y-1 text-sm">
          <div className="flex justify-between">
            <dt className="text-neutral-500">installed</dt>
            <dd className="font-mono text-neutral-200">{cfg.llamaCppInstalled ?? '—'}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-neutral-500">latest</dt>
            <dd className="font-mono text-neutral-200">
              {ok && build
                ? `${build.tag} · ${assetName}${companion ? ' + CUDA DLLs' : ''}`
                : cpp
                  ? 'no matching build'
                  : 'not checked'}
            </dd>
          </div>
          {meta && (
            <div className="flex justify-between">
              <dt className="text-neutral-500">size</dt>
              <dd className="font-mono text-neutral-200">
                {totalMB} MB{companion ? ' (binaries + CUDA DLLs)' : ''}
              </dd>
            </div>
          )}
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
              onClick={() => void runUpdate()}
              disabled={busyAny}
              className="rounded-md bg-sky-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-sky-500 disabled:cursor-wait disabled:opacity-60"
            >
              {updateLabel}
            </button>
          )}
          {cfg.llamaCppInstalled !== null && !updateLabel && (
            <button
              type="button"
              onClick={() => void runUpdate()}
              disabled={busyAny || !ok}
              className="rounded-md border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 transition-colors hover:border-neutral-500 disabled:opacity-50"
            >
              Reinstall
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

        {ok && cfg.llamaCppInstalled !== null && Number(build!.tag.slice(1)) <= Number(cfg.llamaCppInstalled.slice(1)) && (
          <p className="mt-3 text-xs text-emerald-600">Up to date ({cfg.llamaCppInstalled}).</p>
        )}
        {cpp && !cpp.latest && (
          <p className="mt-3 text-xs text-amber-500">
            No build in the last {cpp.builds.length} nightlies has an asset for {cfg.backend} on this OS.
          </p>
        )}
        {phaseLine && <p className="mt-3 text-xs text-neutral-400">{phaseLine}</p>}
        {progress?.component === 'llama-cpp' && phase.status === 'downloading' && <Progress p={progress} />}
        {phase.status === 'done' && <p className="mt-3 text-xs text-emerald-600">{phase.message}</p>}
        {phase.status === 'error' && (
          <p role="alert" className="mt-3 text-xs text-red-400">
            {phase.message}
          </p>
        )}
      </section>
    </>
  )
}

const mb = (n: number) => `${Math.round(n / (1024 * 1024))} MB`

function Progress({ p }: { p: DownloadProgress }) {
  const pct = p.total ? Math.min(100, Math.round((p.received / p.total) * 100)) : null
  return (
    <div className="mt-3">
      <div className="h-1.5 w-full overflow-hidden rounded bg-neutral-800">
        <div
          className={'h-full bg-sky-500 ' + (pct === null ? 'animate-pulse' : 'transition-[width] duration-200')}
          style={{ width: pct !== null ? `${pct}%` : '100%' }}
        />
      </div>
      <p className="mt-1 text-xs text-neutral-400">
        {mb(p.received)}
        {p.total ? ` / ${mb(p.total)} (${pct}%)` : ''}
      </p>
    </div>
  )
}
