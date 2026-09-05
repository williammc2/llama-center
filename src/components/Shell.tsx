import { useEffect, useState, type ReactNode } from 'react'
import { bridge, type SwapStatus } from '../lib/bridge'
import { useAppUpdate } from '../lib/useAppUpdate'
import type { AppConfig } from '../lib/config'
import type { Detection } from '../lib/detect'
import { ServerPage } from '../pages/ServerPage'
import { ModelsPage } from '../pages/ModelsPage'
import { CppPage } from '../pages/CppPage'
import { SettingsPage } from '../pages/SettingsPage'

type Page = 'server' | 'models' | 'cpp' | 'settings'

interface ShellProps {
  cfg: AppConfig
  detection: Detection
  onSaveConfig: (next: AppConfig) => Promise<void>
  onReconfigure: () => void
}

/** App frame: fixed sidebar on the left, one page at a time on the right.
 *  The status poll lives here so the sidebar dot and the Server page share it. */
export function Shell({ cfg, detection, onSaveConfig, onReconfigure }: ShellProps) {
  const [page, setPage] = useState<Page>('server')
  const [status, setStatus] = useState<SwapStatus | null>(null)
  const update = useAppUpdate()

  useEffect(() => {
    const tick = async () => {
      try {
        setStatus(await bridge.llamaSwapStatus())
      } catch {
        // keep the last known state
      }
    }
    void tick()
    const id = setInterval(() => void tick(), 2000)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="flex h-screen overflow-hidden bg-neutral-950 text-neutral-200">
      <aside className="flex w-52 shrink-0 flex-col border-r border-neutral-800 bg-neutral-950 p-3">
        <div className="px-2 pb-4 pt-1">
          <h1 className="text-lg font-semibold tracking-tight text-neutral-100">llama-center</h1>
          <p className="mt-0.5 text-xs text-neutral-600">
            {cfg.backend} · port <span className="font-mono">{cfg.llamaSwapPort}</span>
          </p>
        </div>
        <nav className="flex flex-col gap-1">
          <NavButton active={page === 'server'} onClick={() => setPage('server')} label="Server" dot={status?.portBusy ? (status.healthy ? 'on' : 'warn') : 'off'}>
            <ServerIcon />
          </NavButton>
          <NavButton active={page === 'models'} onClick={() => setPage('models')} label="Models">
            <ModelsIcon />
          </NavButton>
          <NavButton active={page === 'cpp'} onClick={() => setPage('cpp')} label="llama.cpp">
            <ChipIcon />
          </NavButton>
          <NavButton active={page === 'settings'} onClick={() => setPage('settings')} label="Settings">
            <GearIcon />
          </NavButton>
        </nav>
        <AppVersion update={update} onGoToSettings={() => setPage('settings')} />
        <p className="mt-auto px-2 text-[10px] leading-4 text-neutral-700">
          llama-swap {cfg.llamaSwapInstalled === null ? '—' : `v${cfg.llamaSwapInstalled}`} · llama.cpp{' '}
          {cfg.llamaCppInstalled ?? '—'}
        </p>
      </aside>
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl p-6">
          {page === 'server' && (
            <ServerPage cfg={cfg} detection={detection} onSaveConfig={onSaveConfig} status={status} />
          )}
          {page === 'models' && <ModelsPage />}
          {page === 'cpp' && <CppPage cfg={cfg} detection={detection} onSaveConfig={onSaveConfig} />}
          {page === 'settings' && (
            <SettingsPage cfg={cfg} onSaveConfig={onSaveConfig} onReconfigure={onReconfigure} update={update} />
          )}
        </div>
      </main>
    </div>
  )
}

function AppVersion({
  update,
  onGoToSettings,
}: {
  update: ReturnType<typeof useAppUpdate>
  onGoToSettings: () => void
}) {
  // Status line under the version: quiet when healthy, green when there is
  // something to do. The block is always visible — the app version was
  // previously only findable in Settings.
  const { release, checking, installing, error, done, progress } = update

  let status: { text: string; cls: string }
  if (installing) {
    const mb = Math.round((progress?.received ?? 0) / (1024 * 1024))
    status = {
      text: progress?.total !== null && progress ? `${mb} / ${Math.round(progress.total / (1024 * 1024))} MB` : `${mb} MB…`,
      cls: 'text-sky-400',
    }
  } else if (done) {
    status = { text: 'update installed — app closing…', cls: 'text-emerald-400' }
  } else if (checking && !release && !error) {
    status = { text: 'checking…', cls: 'text-neutral-600' }
  } else if (release) {
    status = { text: `v${release.version} available`, cls: 'text-emerald-400' }
  } else if (error) {
    status = { text: 'check failed', cls: 'text-neutral-600' }
  } else {
    status = { text: 'up to date', cls: 'text-neutral-500' }
  }

  return (
    <div className="mt-4 px-2">
      <p className="text-xs text-neutral-400">
        App <span className="font-mono text-neutral-300">v{update.version}</span>
      </p>
      <p className={`mt-0.5 text-xs ${status.cls}`}>{status.text}</p>
      {release && !installing && !done && (
        <div className="mt-2 flex gap-1.5">
          <button
            type="button"
            onClick={() => void update.install()}
            disabled={!release.installerUrl}
            className="flex-1 rounded-md bg-emerald-700 px-2 py-1 text-xs font-medium text-white transition-colors hover:bg-emerald-600 disabled:opacity-50"
          >
            Update now
          </button>
          <button
            type="button"
            onClick={onGoToSettings}
            title="Release notes in Settings"
            className="rounded-md border border-neutral-800 px-2 py-1 text-xs text-neutral-400 transition-colors hover:border-neutral-600 hover:text-neutral-200"
          >
            Details
          </button>
        </div>
      )}
      {error && !installing && (
        <button
          type="button"
          onClick={() => void update.check()}
          className="mt-1 text-xs text-neutral-500 underline decoration-neutral-700 hover:text-neutral-300"
        >
          retry
        </button>
      )}
    </div>
  )
}

function NavButton({
  active,
  onClick,
  label,
  dot,
  children,
}: {
  active: boolean
  onClick: () => void
  label: string
  dot?: 'on' | 'warn' | 'off'
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors ' +
        (active
          ? 'bg-neutral-800 text-neutral-100'
          : 'text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200')
      }
    >
      <span className="shrink-0">{children}</span>
      <span className="flex-1">{label}</span>
      {dot && (
        <span
          className={
            'h-2 w-2 shrink-0 rounded-full ' +
            (dot === 'on' ? 'bg-emerald-500' : dot === 'warn' ? 'bg-amber-500' : 'bg-neutral-700')
          }
        />
      )}
    </button>
  )
}

const iconCls = 'h-4 w-4'

function ServerIcon() {
  return (
    <svg className={iconCls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="8" rx="2" />
      <rect x="2" y="13" width="20" height="8" rx="2" />
      <path d="M6 7h.01M6 17h.01" />
    </svg>
  )
}

function ModelsIcon() {
  return (
    <svg className={iconCls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
      <path d="m3.3 7 8.7 5 8.7-5M12 22V12" />
    </svg>
  )
}

function ChipIcon() {
  return (
    <svg className={iconCls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3" />
    </svg>
  )
}

function GearIcon() {
  return (
    <svg className={iconCls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 1v3M12 20v3M4.22 4.22l2.12 2.12M17.66 17.66l2.12 2.12M1 12h3M20 12h3M4.22 19.78l2.12-2.12M17.66 6.34l2.12-2.12" />
    </svg>
  )
}
