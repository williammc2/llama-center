import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { bridge, type DownloadProgress, type SwapModelDef, type SwapStatus } from '../lib/bridge'
import type { AppConfig } from '../lib/config'
import type { Detection } from '../lib/detect'
import { fetchLatestRelease, pickAsset, type SwapRelease } from '../lib/llamaSwapRelease'
import { assetMeta, checkNightly, companionAsset, requestFromConfig, type NightlyCheck } from '../lib/llamaCppNightly'

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
  /** Open the wizard pre-filled with the current config (change port, etc). */
  onReconfigure?: () => void
}

export function Home({ cfg, detection, onReconfigure }: HomeProps) {
  // llama-swap
  const [latest, setLatest] = useState<SwapRelease | null>(null)
  const [phase, setPhase] = useState<Phase>({ status: 'idle' })
  const [portBusy, setPortBusy] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [backups, setBackups] = useState<string[]>([])
  // llama.cpp
  const [cpp, setCpp] = useState<NightlyCheck | null>(null)
  const [cppPhase, setCppPhase] = useState<Phase>({ status: 'idle' })
  const [cppBackups, setCppBackups] = useState<string[]>([])
  const [progress, setProgress] = useState<DownloadProgress | null>(null)
  const [status, setStatus] = useState<SwapStatus | null>(null)
  const [logs, setLogs] = useState<string[]>([])
  const [showLogs, setShowLogs] = useState(false)
  const [startConflict, setStartConflict] = useState(false)
  const [busy, setBusy] = useState(false)
  const showLogsRef = useRef(showLogs)
  showLogsRef.current = showLogs

  const installed = cfg.llamaSwapInstalled

  const refresh = useCallback(async () => {
    const [list, cppList] = await Promise.all([
      bridge.listComponentBackups('llama-swap'),
      bridge.listComponentBackups('llama-cpp'),
    ])
    setBackups(list)
    setCppBackups(cppList)
  }, [])

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

  const checkCpp = useCallback(async () => {
    if (detection.os === 'unknown' || detection.arch === 'unknown') {
      setCppPhase({ status: 'error', message: 'OS/arch not detected — re-run the wizard' })
      return
    }
    setCppPhase({ status: 'checking' })
    try {
      const result = await checkNightly(requestFromConfig(cfg, detection.os, detection.arch))
      setCpp(result)
      setCppPhase({ status: 'idle' })
    } catch (e) {
      setCppPhase({ status: 'error', message: e instanceof Error ? e.message : 'update check failed' })
    }
  }, [cfg, detection.os, detection.arch])

  useEffect(() => {
    void refresh()
    if (cfg.checkUpdatesOnStart) {
      void check()
      void checkCpp()
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

  // Runtime status poll (~2s): port, /health, /running, and the log tail.
  useEffect(() => {
    const tick = async () => {
      try {
        const s = await bridge.llamaSwapStatus()
        setStatus(s)
        setPortBusy(s.portBusy)
        if (showLogsRef.current) setLogs(await bridge.llamaSwapLogs(200))
      } catch {
        // keep the last known state
      }
    }
    void tick()
    const id = setInterval(() => void tick(), 2000)
    return () => clearInterval(id)
  }, [])

  // --- llama-swap flow ------------------------------------------------------

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
      await bridge.downloadAndStage('llama-swap', asset.url, asset.sha256)
      setPhase({ status: 'installing', message: 'installing…' })
      const backup = await bridge.swapComponent('llama-swap')
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
      const ok = await bridge.rollbackComponent('llama-swap')
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

  // --- start/stop flow ------------------------------------------------------

  const doStart = async (stopFirst: boolean) => {
    setStartConflict(false)
    setBusy(true)
    try {
      if (stopFirst) await bridge.stopLlamaSwap()
      const res = await bridge.startLlamaSwap()
      if (res.error === 'port-in-use') {
        setStartConflict(true)
        return
      }
      if (res.error) {
        setPhase({
          status: 'error',
          message:
            res.error === 'not-installed'
              ? 'install llama-swap first'
              : res.error === 'no-config'
                ? 'no config yet — add a model in the "llama-swap models" card'
                : res.error === 'llama-cpp-not-installed'
                  ? 'install llama.cpp first (the config points at it)'
                  : res.error,
        })
        return
      }
      setPhase({ status: 'done', message: `started (pid ${res.pid})` })
    } finally {
      setBusy(false)
    }
  }

  const startClick = () => {
    if (status?.portBusy) setStartConflict(true)
    else void doStart(false)
  }

  const doStop = async () => {
    setBusy(true)
    try {
      const r = await bridge.stopLlamaSwap()
      setPhase({
        status: r.stopped ? 'done' : 'error',
        message: r.stopped ? `stopped (exit code ${r.exitCode ?? 'n/a'})` : 'not running (or not found)',
      })
    } finally {
      setBusy(false)
    }
  }

  // --- llama.cpp flow -------------------------------------------------------

  const cppResolution = cpp?.latest?.resolution
  const cppOk = cppResolution && cppResolution.status === 'ok' ? cppResolution : null
  const cppAssetName = cppOk?.asset.name ?? null
  const cppBuild = cpp?.latest?.build ?? null
  // `latest.build` is one of `cpp.builds` (resolveLatest picks from it).
  const cppBuildParsed = cpp && cppBuild ? (cpp.builds.find((x) => x.info.tag === cppBuild.tag) ?? null) : null
  const cppMeta = cppBuildParsed && cppAssetName ? assetMeta(cppBuildParsed, cppAssetName) : null
  // Windows CUDA: a second asset (the CUDA runtime DLLs) must be installed
  // alongside the binaries.
  const cppCompanion = cppBuildParsed && cppOk ? companionAsset(cppBuildParsed, cppOk.asset) : null
  const cppCompanionMeta = cppBuildParsed && cppCompanion ? assetMeta(cppBuildParsed, cppCompanion.name) : null
  const cppTotalMB = cppMeta ? Math.round((cppMeta.sizeBytes + (cppCompanionMeta?.sizeBytes ?? 0)) / (1024 * 1024)) : 0

  const cppUpdateLabel = !cppOk
    ? null
    : cfg.llamaCppInstalled === null
      ? 'Install llama.cpp'
      : Number(cppBuild!.tag.slice(1)) > Number(cfg.llamaCppInstalled.slice(1))
        ? `Update to ${cppBuild!.tag}`
        : null

  const runCppUpdate = async () => {
    if (!cppOk || !cppBuild || !cppMeta) return
    setBusy(true)
    try {
      setCppPhase({ status: 'downloading', message: `downloading ${cppMeta.name} (${Math.round(cppMeta.sizeBytes / (1024 * 1024))} MB)…` })
      const staging = await bridge.downloadAndStage('llama-cpp', cppMeta.url, cppMeta.sha256)
      if (cppCompanion && cppCompanionMeta) {
        setCppPhase({
          status: 'downloading',
          message: `downloading CUDA ${cppCompanion.version} DLLs — ${cppCompanionMeta.name} (${Math.round(cppCompanionMeta.sizeBytes / (1024 * 1024))} MB)…`,
        })
        await bridge.downloadAndStage('llama-cpp', cppCompanionMeta.url, cppCompanionMeta.sha256, staging)
      }
      setCppPhase({ status: 'installing', message: 'installing…' })
      const backup = await bridge.swapComponent('llama-cpp')
      await bridge.saveConfig({ ...cfg, llamaCppInstalled: cppBuild.tag })
      setCppPhase({
        status: 'done',
        message: backup ? `done — ${backup} kept for rollback` : `installed ${cppBuild.tag}`,
      })
      await refresh()
    } catch (e) {
      setCppPhase({ status: 'error', message: e instanceof Error ? e.message : 'update failed' })
    } finally {
      setBusy(false)
    }
  }

  const doCppRollback = async () => {
    if (cppBackups.length === 0) return
    setBusy(true)
    try {
      const ok = await bridge.rollbackComponent('llama-cpp')
      if (!ok) {
        setCppPhase({ status: 'error', message: 'no backups to roll back to' })
        return
      }
      const m = /b(\d+)/.exec(cppBackups[0])
      if (m) await bridge.saveConfig({ ...cfg, llamaCppInstalled: `b${m[1]}` })
      setCppPhase({ status: 'done', message: `rolled back to ${cppBackups[0]}` })
      await refresh()
    } catch (e) {
      setCppPhase({ status: 'error', message: e instanceof Error ? e.message : 'rollback failed' })
    } finally {
      setBusy(false)
    }
  }

  // --- render ---------------------------------------------------------------

  const upToDate = latest !== null && installed !== null && latest.version <= installed
  const busyAny = busy || phase.status === 'checking' || phase.status === 'downloading' || phase.status === 'installing'
  const cppBusyAny = busy || cppPhase.status === 'checking' || cppPhase.status === 'downloading' || cppPhase.status === 'installing'
  const phaseLine =
    phase.status === 'downloading' || phase.status === 'installing' ? phase.message ?? null : null
  const cppPhaseLine =
    cppPhase.status === 'downloading' || cppPhase.status === 'installing' ? cppPhase.message ?? null : null

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">llama-center</h1>
          <p className="mt-1 text-sm text-neutral-500">
            backend <span className="font-mono text-neutral-400">{cfg.backend}</span> · port{' '}
            <span className="font-mono text-neutral-400">{cfg.llamaSwapPort}</span>
          </p>
        </div>
        {onReconfigure && (
          <button
            type="button"
            onClick={onReconfigure}
            className="mt-1 rounded-md border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 transition-colors hover:border-neutral-500"
          >
            Change setup
          </button>
        )}
      </header>

      {/* llama-swap */}
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
            <dt className="text-neutral-500">status</dt>
            <dd className="flex items-center gap-2 font-mono text-neutral-200">
              {status?.portBusy
                ? status.managed
                  ? `running (managed, pid ${status.pid})`
                  : 'running (external)'
                : 'stopped'}
              {status?.portBusy && (
                <button
                  type="button"
                  onClick={() => void bridge.openUrl(`http://localhost:${cfg.llamaSwapPort}/`)}
                  className="text-xs text-sky-400 underline decoration-sky-700 transition-colors hover:text-sky-300"
                >
                  open dashboard
                </button>
              )}
            </dd>
          </div>
          {status && status.models.length > 0 && (
            <div className="flex justify-between">
              <dt className="text-neutral-500">models</dt>
              <dd className="max-w-[60%] truncate font-mono text-neutral-200" title={status.models.map((m) => m.model).join(', ')}>
                {status.models.map((m) => m.model).join(', ')}
              </dd>
            </div>
          )}
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
          {status?.portBusy ? (
            <button
              type="button"
              onClick={() => void doStop()}
              disabled={busyAny}
              className="rounded-md border border-amber-700 px-4 py-1.5 text-sm font-medium text-amber-300 transition-colors hover:border-amber-500 disabled:opacity-50"
            >
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={startClick}
              disabled={busyAny}
              className="rounded-md bg-emerald-700 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-emerald-600 disabled:cursor-wait disabled:opacity-60"
            >
              Start
            </button>
          )}
          <button
            type="button"
            onClick={() => setShowLogs((v) => !v)}
            className="rounded-md border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 transition-colors hover:border-neutral-500"
          >
            {showLogs ? 'Hide logs' : 'Logs'}
          </button>
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

        {showLogs && (
          <pre className="mt-3 max-h-48 overflow-auto rounded border border-neutral-800 bg-neutral-950 p-2 font-mono text-[11px] leading-4 text-neutral-300">
            {logs.length ? logs.join('\n') : 'no output yet'}
          </pre>
        )}
        {upToDate && latest && <p className="mt-3 text-xs text-emerald-600">Up to date (v{installed}).</p>}
        {phaseLine && <p className="mt-3 text-xs text-neutral-400">{phaseLine}</p>}
        {progress?.component === 'llama-swap' && phase.status === 'downloading' && <Progress p={progress} />}
        {phase.status === 'done' && <p className="mt-3 text-xs text-emerald-600">{phase.message}</p>}
        {phase.status === 'error' && (
          <p role="alert" className="mt-3 text-xs text-red-400">
            {phase.message}
          </p>
        )}
      </section>

      {/* llama-swap models */}
      <SwapModelsCard />

      {/* llama.cpp */}
      <section className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-4">
        <h2 className="text-sm font-medium text-neutral-300">llama.cpp</h2>

        <dl className="mt-3 space-y-1 text-sm">
          <div className="flex justify-between">
            <dt className="text-neutral-500">installed</dt>
            <dd className="font-mono text-neutral-200">{cfg.llamaCppInstalled ?? '—'}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-neutral-500">latest</dt>
            <dd className="font-mono text-neutral-200">
              {cppOk && cppBuild
                ? `${cppBuild.tag} · ${cppAssetName}${cppCompanion ? ' + CUDA DLLs' : ''}`
                : cpp
                  ? 'no matching build'
                  : 'not checked'}
            </dd>
          </div>
          {cppMeta && (
            <div className="flex justify-between">
              <dt className="text-neutral-500">size</dt>
              <dd className="font-mono text-neutral-200">
                {cppTotalMB} MB{cppCompanion ? ' (binaries + CUDA DLLs)' : ''}
              </dd>
            </div>
          )}
          <div className="flex justify-between">
            <dt className="text-neutral-500">backups</dt>
            <dd className="font-mono text-neutral-200">{cppBackups.length}</dd>
          </div>
        </dl>

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void checkCpp()}
            disabled={cppBusyAny}
            className="rounded-md border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 transition-colors hover:border-neutral-500 disabled:opacity-50"
          >
            {cppPhase.status === 'checking' ? 'Checking…' : 'Check for updates'}
          </button>
          {cppUpdateLabel && (
            <button
              type="button"
              onClick={() => void runCppUpdate()}
              disabled={cppBusyAny}
              className="rounded-md bg-sky-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-sky-500 disabled:cursor-wait disabled:opacity-60"
            >
              {cppUpdateLabel}
            </button>
          )}
          {cfg.llamaCppInstalled !== null && !cppUpdateLabel && (
            <button
              type="button"
              onClick={() => void runCppUpdate()}
              disabled={cppBusyAny || !cppOk}
              className="rounded-md border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 transition-colors hover:border-neutral-500 disabled:opacity-50"
            >
              Reinstall
            </button>
          )}
          {cppBackups.length > 0 && (
            <button
              type="button"
              onClick={() => void doCppRollback()}
              disabled={cppBusyAny}
              className="rounded-md border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 transition-colors hover:border-neutral-500 disabled:opacity-50"
            >
              Rollback
            </button>
          )}
        </div>

        {cppOk && cfg.llamaCppInstalled !== null && Number(cppBuild!.tag.slice(1)) <= Number(cfg.llamaCppInstalled.slice(1)) && (
          <p className="mt-3 text-xs text-emerald-600">Up to date ({cfg.llamaCppInstalled}).</p>
        )}
        {cpp && !cpp.latest && (
          <p className="mt-3 text-xs text-amber-500">
            No build in the last {cpp.builds.length} nightlies has an asset for {cfg.backend} on this OS.
          </p>
        )}
        {cppPhaseLine && <p className="mt-3 text-xs text-neutral-400">{cppPhaseLine}</p>}
        {progress?.component === 'llama-cpp' && cppPhase.status === 'downloading' && <Progress p={progress} />}
        {cppPhase.status === 'done' && <p className="mt-3 text-xs text-emerald-600">{cppPhase.message}</p>}
        {cppPhase.status === 'error' && (
          <p role="alert" className="mt-3 text-xs text-red-400">
            {cppPhase.message}
          </p>
        )}
      </section>

      {startConflict && (
        <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/60 px-4">
          <div className="w-full max-w-md rounded-lg border border-neutral-700 bg-neutral-900 p-5">
            <h3 className="text-sm font-medium text-neutral-200">Port {cfg.llamaSwapPort} is in use</h3>
            <p className="mt-2 text-sm text-neutral-400">
              Something is already listening — likely a llama-swap started outside this app.
            </p>
            <div className="mt-4 flex flex-col gap-2">
              <button
                type="button"
                onClick={() => void doStart(true)}
                className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-500"
              >
                Stop & start
              </button>
              <button
                type="button"
                onClick={() => setStartConflict(false)}
                className="rounded-md border border-neutral-700 px-4 py-2 text-sm text-neutral-300 transition-colors hover:border-neutral-500"
              >
                Adopt (leave it running)
              </button>
              <button
                type="button"
                onClick={() => setStartConflict(false)}
                className="rounded-md border border-neutral-700 px-4 py-2 text-sm text-neutral-300 transition-colors hover:border-neutral-500"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
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

const mb = (n: number) => `${Math.round(n / (1024 * 1024))} MB`

/** Download progress bar — % when the server sent Content-Length, else
 *  an indeterminate (pulsing) bar with the byte count. */
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

// --- llama-swap models (P4) -------------------------------------------------

const emptyModel = (): SwapModelDef => ({
  name: '',
  model: '',
  mmproj: null,
  draft: null,
  ctxSize: 8192,
  gpuLayers: 999,
  threads: null,
  extraFlags: '',
})

function modelErrors(m: SwapModelDef, all: SwapModelDef[]): Record<string, string> {
  const e: Record<string, string> = {}
  if (!m.name.trim()) e.name = 'required'
  else if (all.some((x) => x !== m && x.name === m.name)) e.name = 'duplicate name'
  if (!m.model.trim()) e.model = 'required'
  if (!(m.ctxSize > 0)) e.ctxSize = 'must be > 0'
  if (!(m.gpuLayers > 0)) e.gpuLayers = 'must be > 0'
  if (m.threads != null && !(m.threads > 0)) e.threads = 'must be > 0'
  return e
}

const inputCls =
  'w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-xs text-neutral-200 focus:border-sky-600 focus:outline-none'

function Field({
  label,
  error,
  children,
}: {
  label: string
  error?: string
  children: ReactNode
}) {
  return (
    <label className="block">
      <span className="mb-1 flex items-center gap-2 text-xs text-neutral-500">
        {label}
        {error && <span className="text-red-400">{error}</span>}
      </span>
      {children}
    </label>
  )
}

/** Editor for the llama-swap config: one box per model, the app renders the
 *  `cmd` line (llama-server path abstracted to the managed llama.cpp). */
function SwapModelsCard() {
  const [models, setModels] = useState<SwapModelDef[]>([emptyModel()])
  const [loaded, setLoaded] = useState(false)
  const [importPath, setImportPath] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [open, setOpen] = useState<Record<number, boolean>>({})

  useEffect(() => {
    void bridge
      .getLlamaSwapConfig()
      .then((r) => setModels(r.models.length ? r.models : [emptyModel()]))
      .finally(() => setLoaded(true))
  }, [])

  const toggle = (i: number) => setOpen((o) => ({ ...o, [i]: !o[i] }))

  const set = (i: number, patch: Partial<SwapModelDef>) =>
    setModels((ms) => ms.map((m, j) => (j === i ? { ...m, ...patch } : m)))

  const allErrors = models.map((m) => modelErrors(m, models))
  const hasErrors = allErrors.some((e) => Object.keys(e).length > 0)
  const hasModel = models.some((m) => m.name.trim() || m.model.trim())

  const save = async () => {
    setSaving(true)
    setMsg(null)
    try {
      const res = await bridge.saveLlamaSwapConfig(models.filter((m) => m.name.trim()))
      if (res.error) setMsg({ kind: 'err', text: res.error })
      else setMsg({ kind: 'ok', text: `saved → ${res.path}` })
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : 'save failed' })
    } finally {
      setSaving(false)
    }
  }

  const doImport = async () => {
    setMsg(null)
    const res = await bridge.importLlamaSwapConfig(importPath.trim())
    if (res.error) setMsg({ kind: 'err', text: res.error })
    else if (res.models) {
      setModels(res.models)
      setMsg({ kind: 'ok', text: `imported ${res.models.length} model(s) — review and save` })
    }
  }

  return (
    <section className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-neutral-300">llama-swap models</h2>
        <span className="text-xs text-neutral-600">
          {loaded ? `${models.filter((m) => m.name.trim()).length} model(s)` : 'loading…'}
        </span>
      </div>
      <p className="mt-1 text-xs text-neutral-600">
        The llama-server path is filled in automatically (managed llama.cpp). Extra flags are
        appended verbatim (spec decoding, sampling…).
      </p>

      <div className="mt-3 space-y-3">
        {models.map((m, i) => {
          const errs = allErrors[i]
          const hasErr = Object.keys(errs).length > 0
          return (
            <div key={i} className="rounded border border-neutral-800 bg-neutral-950/60">
              <div className="flex items-center justify-between gap-2 px-3 py-2">
                <button
                  type="button"
                  onClick={() => toggle(i)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                  <span className="font-mono text-xs text-neutral-500">{open[i] ? '▾' : '▸'}</span>
                  <span className="truncate font-mono text-xs text-neutral-300">
                    {m.name || `model #${i + 1}`}
                    {m.model && <span className="text-neutral-600"> · {m.model}</span>}
                  </span>
                  {hasErr && <span className="h-2 w-2 shrink-0 rounded-full bg-red-500" title="has validation errors" />}
                </button>
                {models.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setModels((ms) => ms.filter((_, j) => j !== i))}
                    className="text-xs text-neutral-500 transition-colors hover:text-red-400"
                  >
                    remove
                  </button>
                )}
              </div>
              {open[i] && (
                <div className="px-3 pb-3">
                  <div className="mt-1 grid grid-cols-2 gap-2">
                <Field label="name" error={errs.name}>
                  <input className={inputCls} value={m.name} onChange={(e) => set(i, { name: e.target.value })} placeholder="qwen3.8-27b" />
                </Field>
                <Field label="ctx-size" error={errs.ctxSize}>
                  <input className={inputCls} type="number" value={m.ctxSize} onChange={(e) => set(i, { ctxSize: Number(e.target.value) })} />
                </Field>
                <div className="col-span-2">
                  <Field label="model (.gguf)" error={errs.model}>
                    <input className={inputCls} value={m.model} onChange={(e) => set(i, { model: e.target.value })} placeholder="D:\models\....gguf" />
                  </Field>
                </div>
                <Field label="mmproj (optional)">
                  <input className={inputCls} value={m.mmproj ?? ''} onChange={(e) => set(i, { mmproj: e.target.value || null })} />
                </Field>
                <Field label="draft model (optional)">
                  <input className={inputCls} value={m.draft ?? ''} onChange={(e) => set(i, { draft: e.target.value || null })} />
                </Field>
                <Field label="gpu-layers" error={errs.gpuLayers}>
                  <input className={inputCls} type="number" value={m.gpuLayers} onChange={(e) => set(i, { gpuLayers: Number(e.target.value) })} />
                </Field>
                <Field label="threads (optional)" error={errs.threads}>
                  <input className={inputCls} type="number" value={m.threads ?? ''} onChange={(e) => set(i, { threads: e.target.value === '' ? null : Number(e.target.value) })} />
                </Field>
                <div className="col-span-2">
                  <Field label="extra flags (optional)">
                    <textarea
                      className={inputCls + ' h-16 resize-y'}
                      value={m.extraFlags}
                      onChange={(e) => set(i, { extraFlags: e.target.value })}
                      placeholder={'--flash-attn on\n--spec-type draft-mtp ...'}
                    />
                  </Field>
                </div>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setModels((ms) => [...ms, emptyModel()])}
          className="rounded-md border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 transition-colors hover:border-neutral-500"
        >
          + Add model
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || !loaded || hasErrors || !hasModel}
          className="rounded-md bg-emerald-700 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-emerald-600 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save config'}
        </button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          className={inputCls + ' max-w-[320px]'}
          value={importPath}
          onChange={(e) => setImportPath(e.target.value)}
          placeholder="import from: D:\llama-swap\config.yaml"
        />
        <button
          type="button"
          onClick={() => void doImport()}
          disabled={!importPath.trim()}
          className="rounded-md border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 transition-colors hover:border-neutral-500 disabled:opacity-50"
        >
          Import
        </button>
      </div>

      {msg && (
        <p className={'mt-2 text-xs ' + (msg.kind === 'ok' ? 'text-emerald-600' : 'text-red-400')}>
          {msg.text}
        </p>
      )}
    </section>
  )
}
