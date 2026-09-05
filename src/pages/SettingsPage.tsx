import { useEffect, useState } from 'react'
import { bridge, type DownloadProgress } from '../lib/bridge'
import type { AppConfig } from '../lib/config'
import { checkAppUpdate, CHECK_TIMEOUT_MS, type AppRelease } from '../lib/appUpdate'

interface SettingsPageProps {
  cfg: AppConfig
  onSaveConfig: (next: AppConfig) => Promise<void>
  onReconfigure: () => void
}

const inputCls =
  'w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 font-mono text-sm text-neutral-200 focus:border-sky-600 focus:outline-none'

function Toggle({
  label,
  hint,
  value,
  onChange,
}: {
  label: string
  hint: string
  value: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-md border border-neutral-800 bg-neutral-950/60 p-3">
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 accent-sky-600"
      />
      <span>
        <span className="block text-sm text-neutral-200">{label}</span>
        <span className="block text-xs text-neutral-500">{hint}</span>
      </span>
    </label>
  )
}

export function SettingsPage({ cfg, onSaveConfig, onReconfigure }: SettingsPageProps) {
  const [port, setPort] = useState(cfg.llamaSwapPort)
  const [installDir, setInstallDir] = useState(cfg.installDir)
  const [checkUpdatesOnStart, setCheckUpdatesOnStart] = useState(cfg.checkUpdatesOnStart)
  const [autoStartLlamaSwap, setAutoStartLlamaSwap] = useState(cfg.autoStartLlamaSwap)
  const [closeToTray, setCloseToTray] = useState(cfg.closeToTray)
  const [startWithSystem, setStartWithSystem] = useState(cfg.startWithSystem)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  // App self-update state
  const [appUpdate, setAppUpdate] = useState<AppRelease | null>(null)
  const [checkingApp, setCheckingApp] = useState(false)
  const [checkStartedAt, setCheckStartedAt] = useState<number | null>(null)
  const [installingApp, setInstallingApp] = useState(false)
  const [appUpdateMsg, setAppUpdateMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [appProgress, setAppProgress] = useState<DownloadProgress | null>(null)

  // Countdown shown on the button while a check is in flight: the check is
  // bounded (CHECK_TIMEOUT_MS), so the user always sees how much longer it
  // can take — no silent "dead button" to click again.
  const [, forceTick] = useState(0)
  useEffect(() => {
    if (checkStartedAt === null) return
    const id = setInterval(() => forceTick((n) => n + 1), 250)
    return () => clearInterval(id)
  }, [checkStartedAt])
  const checkRemaining =
    checkStartedAt !== null ? Math.max(0, Math.ceil((checkStartedAt + CHECK_TIMEOUT_MS - Date.now()) / 1000)) : 0

  const checkApp = async () => {
    setCheckingApp(true)
    setCheckStartedAt(Date.now())
    setAppUpdateMsg(null)
    try {
      const release = await checkAppUpdate(import.meta.env.VITE_APP_VERSION)
      setAppUpdate(release)
      if (!release) setAppUpdateMsg({ kind: 'ok', text: 'up to date' })
    } catch (e) {
      setAppUpdateMsg({ kind: 'err', text: e instanceof Error ? e.message : 'check failed' })
    } finally {
      setCheckingApp(false)
      setCheckStartedAt(null)
    }
  }

  const installApp = async () => {
    if (!appUpdate?.installerUrl) return
    setInstallingApp(true)
    setAppUpdateMsg(null)
    try {
      const res = await bridge.downloadAndLaunchInstaller(appUpdate.installerUrl)
      if (res.closing) {
        setAppUpdateMsg({ kind: 'ok', text: 'update installed — closing app…' })
      } else {
        setAppUpdateMsg({ kind: 'ok', text: 'installer launched' })
      }
    } catch (e) {
      setAppUpdateMsg({ kind: 'err', text: e instanceof Error ? e.message : 'install failed' })
    } finally {
      setInstallingApp(false)
    }
  }

  // Subscribe to download progress for the app installer
  useEffect(() => {
    let off: (() => void) | undefined
    void bridge.onDownloadProgress((p) => {
      if (p.component === 'app') setAppProgress(p)
    }).then((u) => {
      off = u
    })
    return () => {
      off?.()
    }
  }, [])

  const dirty =
    port !== cfg.llamaSwapPort ||
    installDir !== cfg.installDir ||
    checkUpdatesOnStart !== cfg.checkUpdatesOnStart ||
    autoStartLlamaSwap !== cfg.autoStartLlamaSwap ||
    closeToTray !== cfg.closeToTray ||
    startWithSystem !== cfg.startWithSystem

  const save = async () => {
    setSaving(true)
    setMsg(null)
    try {
      await onSaveConfig({
        ...cfg,
        llamaSwapPort: port,
        installDir,
        checkUpdatesOnStart,
        autoStartLlamaSwap,
        closeToTray,
        startWithSystem,
      })
      setMsg({ kind: 'ok', text: 'saved' })
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : 'save failed' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <h2 className="text-lg font-semibold text-neutral-100">Settings</h2>
      <p className="mt-1 text-sm text-neutral-500">App preferences. Backend and CUDA come from the setup wizard.</p>

      <section className="mt-4 space-y-3 rounded-lg border border-neutral-800 bg-neutral-900/60 p-4">
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs text-neutral-500">llama-swap port</span>
            <input
              className={inputCls}
              type="number"
              value={port}
              onChange={(e) => setPort(Number(e.target.value))}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-neutral-500">install dir</span>
            <input
              className={inputCls}
              value={installDir}
              onChange={(e) => setInstallDir(e.target.value)}
            />
          </label>
        </div>

        <div className="flex items-center justify-between rounded-md border border-neutral-800 bg-neutral-950/60 p-3">
          <span>
            <span className="block text-sm text-neutral-200">backend</span>
            <span className="block font-mono text-xs text-neutral-500">
              {cfg.backend}
              {cfg.backend === 'cuda' && cfg.cudaMajor ? ` (CUDA ${cfg.cudaMajor})` : ''} · pinned{' '}
              {cfg.llamaCppPin ?? 'latest'}
            </span>
          </span>
          <button
            type="button"
            onClick={onReconfigure}
            className="rounded-md border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 transition-colors hover:border-neutral-500"
          >
            Change setup
          </button>
        </div>

        <div className="space-y-2">
          <Toggle
            label="Check for updates on start"
            hint="llama-swap and llama.cpp are checked when the app opens."
            value={checkUpdatesOnStart}
            onChange={setCheckUpdatesOnStart}
          />
          <Toggle
            label="Start llama-swap when the app starts"
            hint="The server starts with the app (only when the port is free)."
            value={autoStartLlamaSwap}
            onChange={setAutoStartLlamaSwap}
          />
          <Toggle
            label="Close to tray"
            hint="Closing the window minimizes to the tray instead of quitting."
            value={closeToTray}
            onChange={setCloseToTray}
          />
          <Toggle
            label="Start with system"
            hint="The app starts at login, minimized to the tray."
            value={startWithSystem}
            onChange={setStartWithSystem}
          />
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || !dirty || !(port > 0) || !installDir.trim()}
            className="rounded-md bg-emerald-700 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-emerald-600 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          {msg && (
            <span className={'text-xs ' + (msg.kind === 'ok' ? 'text-emerald-600' : 'text-red-400')}>
              {msg.text}
            </span>
          )}
        </div>
      </section>

      {/* App self-update */}
      <section className="mt-4 rounded-lg border border-neutral-800 bg-neutral-900/60 p-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium text-neutral-200">App version</h3>
            <p className="font-mono text-xs text-neutral-500">v{import.meta.env.VITE_APP_VERSION}</p>
          </div>
          <button
            type="button"
            onClick={() => void checkApp()}
            disabled={checkingApp || installingApp}
            className="rounded-md border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 transition-colors hover:border-neutral-500 disabled:opacity-50"
          >
            {checkingApp ? `Checking… ${checkRemaining}s` : 'Check for update'}
          </button>
        </div>

        {appUpdate && (
          <div className="mt-3 rounded-md border border-sky-900 bg-sky-950/30 p-3">
            <p className="text-sm font-medium text-sky-300">v{appUpdate.version} available</p>
            {appUpdate.notes && (
              <div className="mt-2 max-h-32 overflow-auto rounded bg-neutral-950/60 p-2">
                <pre className="whitespace-pre-wrap font-sans text-xs text-neutral-400">
                  {appUpdate.notes}
                </pre>
              </div>
            )}
            {appUpdate.installerUrl && (
              <button
                type="button"
                onClick={() => void installApp()}
                disabled={installingApp}
                className="mt-3 rounded-md bg-sky-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-sky-500 disabled:cursor-wait disabled:opacity-60"
              >
                {installingApp ? 'Downloading…' : 'Download & install'}
              </button>
            )}
          </div>
        )}

        {appProgress && installingApp && (
          <div className="mt-3">
            <div className="h-1.5 w-full overflow-hidden rounded bg-neutral-800">
              <div
                className={
                  'h-full bg-sky-500 ' +
                  (appProgress.total === null ? 'animate-pulse' : 'transition-[width] duration-200')
                }
                style={{
                  width:
                    appProgress.total !== null
                      ? `${Math.min(100, Math.round((appProgress.received / appProgress.total) * 100))}%`
                      : '100%',
                }}
              />
            </div>
            <p className="mt-1 text-xs text-neutral-400">
              {Math.round(appProgress.received / (1024 * 1024))} MB
              {appProgress.total !== null
                ? ` / ${Math.round(appProgress.total / (1024 * 1024))} MB`
                : ''}
            </p>
          </div>
        )}

        {appUpdateMsg && (
          <p className={'mt-3 text-xs ' + (appUpdateMsg.kind === 'ok' ? 'text-emerald-600' : 'text-red-400')}>
            {appUpdateMsg.text}
          </p>
        )}
      </section>
    </>
  )
}
