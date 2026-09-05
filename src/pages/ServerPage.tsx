import { useEffect, useRef, useState } from 'react'
import { bridge, type DownloadProgress, type SwapStatus } from '../lib/bridge'
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

interface ServerPageProps {
  cfg: AppConfig
  detection: Detection
  onSaveConfig: (next: AppConfig) => Promise<void>
  /** Shared 2s status poll (the sidebar dot uses it too). */
  status: SwapStatus | null
}

export function ServerPage({ cfg, detection, onSaveConfig, status }: ServerPageProps) {
  const [latest, setLatest] = useState<SwapRelease | null>(null)
  const [phase, setPhase] = useState<Phase>({ status: 'idle' })
  const [conflict, setConflict] = useState(false)
  const [backups, setBackups] = useState<string[]>([])
  const [progress, setProgress] = useState<DownloadProgress | null>(null)
  const [logs, setLogs] = useState<string[]>([])
  const [showLogs, setShowLogs] = useState(false)
  const [startConflict, setStartConflict] = useState(false)
  const [busy, setBusy] = useState(false)
  const showLogsRef = useRef(showLogs)
  showLogsRef.current = showLogs

  const installed = cfg.llamaSwapInstalled
  const portBusy = !!status?.portBusy

  const refresh = async () => {
    setBackups(await bridge.listComponentBackups('llama-swap'))
  }

  const check = async () => {
    setPhase({ status: 'checking' })
    try {
      setLatest(await fetchLatestRelease())
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

  // Log tail: only while the page is mounted and the terminal is open.
  useEffect(() => {
    const tick = async () => {
      if (showLogsRef.current) setLogs(await bridge.llamaSwapLogs(200))
    }
    void tick()
    const id = setInterval(() => void tick(), 2000)
    return () => clearInterval(id)
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
      await bridge.downloadAndStage('llama-swap', asset.url, asset.sha256)
      setPhase({ status: 'installing', message: 'installing…' })
      const backup = await bridge.swapComponent('llama-swap')
      await onSaveConfig({ ...cfg, llamaSwapInstalled: latest.version })
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
      if (m) await onSaveConfig({ ...cfg, llamaSwapInstalled: Number(m[1]) })
      setPhase({ status: 'done', message: `rolled back to ${backups[0]}` })
      await refresh()
    } catch (e) {
      setPhase({ status: 'error', message: e instanceof Error ? e.message : 'rollback failed' })
    } finally {
      setBusy(false)
    }
  }

  // --- start/stop -----------------------------------------------------------

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
                ? 'no config yet — add a model in the Models page'
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
    if (portBusy) setStartConflict(true)
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

  // --- render ---------------------------------------------------------------

  const upToDate = latest !== null && installed !== null && latest.version <= installed
  const busyAny = busy || phase.status === 'checking' || phase.status === 'downloading' || phase.status === 'installing'
  const phaseLine =
    phase.status === 'downloading' || phase.status === 'installing' ? phase.message ?? null : null

  return (
    <>
      <h2 className="text-lg font-semibold text-neutral-100">Server</h2>
      <p className="mt-1 text-sm text-neutral-500">llama-swap — start, stop, logs and updates.</p>

      <section className="mt-4 rounded-lg border border-neutral-800 bg-neutral-900/60 p-4">
        <dl className="space-y-1 text-sm">
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
              <dd
                className="max-w-[60%] truncate font-mono text-neutral-200"
                title={status.models.map((m) => m.model).join(', ')}
              >
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
              {(() => { const m = /v(\d+)/.exec(backups[0]); return m ? `Rollback → v${m[1]}` : 'Rollback' })()}
            </button>
          )}
          {backups.length > 0 && (
            <button
              type="button"
              onClick={() => void bridge.openPath(`${cfg.installDir}/backups/llama-swap`)}
              className="rounded-md border border-neutral-700 px-3 py-1.5 text-sm text-neutral-500 transition-colors hover:border-neutral-500 hover:text-neutral-300"
            >
              Open backups
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

      {startConflict && (
        <ConflictDialog
          title={`Port ${cfg.llamaSwapPort} is in use`}
          body="Something is already listening — likely a llama-swap started outside this app."
          primary={{ label: 'Stop & start', onClick: () => void doStart(true) }}
          secondary={{ label: 'Adopt (leave it running)', onClick: () => setStartConflict(false) }}
          cancel={{ label: 'Cancel', onClick: () => setStartConflict(false) }}
        />
      )}
      {conflict && (
        <ConflictDialog
          title={`Port ${cfg.llamaSwapPort} is in use`}
          body="Something is already listening — likely a llama-swap started outside this app."
          primary={{ label: 'Stop & take over', onClick: () => void runUpdate(false) }}
          secondary={{ label: 'Adopt (update without stopping)', onClick: () => void runUpdate(true) }}
          cancel={{ label: 'Cancel', onClick: () => setConflict(false) }}
        />
      )}
    </>
  )
}

function ConflictDialog({
  title,
  body,
  primary,
  secondary,
  cancel,
}: {
  title: string
  body: string
  primary: { label: string; onClick: () => void }
  secondary: { label: string; onClick: () => void }
  cancel: { label: string; onClick: () => void }
}) {
  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/60 px-4">
      <div className="w-full max-w-md rounded-lg border border-neutral-700 bg-neutral-900 p-5">
        <h3 className="text-sm font-medium text-neutral-200">{title}</h3>
        <p className="mt-2 text-sm text-neutral-400">{body}</p>
        <div className="mt-4 flex flex-col gap-2">
          <button
            type="button"
            onClick={primary.onClick}
            className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-500"
          >
            {primary.label}
          </button>
          <button
            type="button"
            onClick={secondary.onClick}
            className="rounded-md border border-neutral-700 px-4 py-2 text-sm text-neutral-300 transition-colors hover:border-neutral-500"
          >
            {secondary.label}
          </button>
          <button
            type="button"
            onClick={cancel.onClick}
            className="rounded-md border border-neutral-700 px-4 py-2 text-sm text-neutral-300 transition-colors hover:border-neutral-500"
          >
            {cancel.label}
          </button>
        </div>
      </div>
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
