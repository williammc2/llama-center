import { useEffect, useState } from 'react'
import type { AppConfig } from '../lib/config'
import type { AppUpdateState } from '../lib/useAppUpdate'
import { CHECK_TIMEOUT_MS } from '../lib/appUpdate'
import { Progress } from '../components/Progress'
import { SettingToggle } from '../components/ui'

interface SettingsPageProps {
  cfg: AppConfig
  onSaveConfig: (next: AppConfig) => Promise<void>
  onReconfigure: () => void
  /** Shared app-update state (owned by Shell — single check per boot). */
  update: AppUpdateState
}

// Settings uses a slightly larger field style (py-1.5 / text-sm) than the
// models editor (py-1 / text-xs) — kept local on purpose.
const inputCls =
  'w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 font-mono text-sm text-neutral-200 focus:border-sky-600 focus:outline-none'

/** The editable settings fields (a subset of AppConfig). */
interface SettingsDraft {
  llamaSwapPort: number
  installDir: string
  checkUpdatesOnStart: boolean
  autoStartLlamaSwap: boolean
  closeToTray: boolean
  startWithSystem: boolean
  hfToken: string
  modelDirs: string[]
}

const draftFrom = (cfg: AppConfig): SettingsDraft => ({
  llamaSwapPort: cfg.llamaSwapPort,
  installDir: cfg.installDir,
  checkUpdatesOnStart: cfg.checkUpdatesOnStart,
  autoStartLlamaSwap: cfg.autoStartLlamaSwap,
  closeToTray: cfg.closeToTray,
  startWithSystem: cfg.startWithSystem,
  hfToken: cfg.hfToken,
  modelDirs: cfg.modelDirs,
})

export function SettingsPage({ cfg, onSaveConfig, onReconfigure, update }: SettingsPageProps) {
  // One draft object instead of six useStates: `dirty` becomes a shallow
  // comparison and adding a field is one line, not a new useState + a new
  // `||` clause in the dirty check.
  const [draft, setDraft] = useState<SettingsDraft>(() => draftFrom(cfg))
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [newModelDir, setNewModelDir] = useState('')
  const patch = (p: Partial<SettingsDraft>) => setDraft((d) => ({ ...d, ...p }))

  const addModelDir = () => {
    const d = newModelDir.trim()
    if (!d || draft.modelDirs.includes(d)) return
    patch({ modelDirs: [...draft.modelDirs, d] })
    setNewModelDir('')
  }

  const {
    version,
    release,
    checking,
    installing,
    error,
    done,
    progress,
    checkStartedAt,
    check: checkApp,
    install: installApp,
  } = update

  const [remaining, setRemaining] = useState(0)
  useEffect(() => {
    if (checkStartedAt === null) return
    const tick = () =>
      setRemaining(Math.max(0, Math.ceil((checkStartedAt + CHECK_TIMEOUT_MS - Date.now()) / 1000)))
    const id = setInterval(tick, 250)
    tick()
    return () => clearInterval(id)
  }, [checkStartedAt])

  // The countdown: the check is bounded (CHECK_TIMEOUT_MS), so the user always
  // sees how much longer it can take — no silent "dead button".
  const checkRemaining = remaining

  const dirty = (Object.keys(draft) as (keyof SettingsDraft)[]).some(
    (k) => draft[k] !== cfg[k],
  )

  const save = async () => {
    setSaving(true)
    setMsg(null)
    try {
      await onSaveConfig({ ...cfg, ...draft })
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
              value={draft.llamaSwapPort}
              onChange={(e) => patch({ llamaSwapPort: Number(e.target.value) })}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-neutral-500">install dir</span>
            <input
              className={inputCls}
              value={draft.installDir}
              onChange={(e) => patch({ installDir: e.target.value })}
            />
          </label>
        </div>

        <label className="block">
          <span className="mb-1 block text-xs text-neutral-500">
            HuggingFace token <span className="text-neutral-600">(optional — for gated repos + higher rate limit)</span>
          </span>
          <input
            className={inputCls}
            type="password"
            value={draft.hfToken}
            onChange={(e) => patch({ hfToken: e.target.value })}
            placeholder="hf_… (leave empty for public files)"
            autoComplete="off"
          />
        </label>

        <div>
          <span className="mb-1 block text-xs text-neutral-500">
            Model folders <span className="text-neutral-600">(extra roots scanned for models, alongside the app's models folder)</span>
          </span>
          {draft.modelDirs.length > 0 && (
            <ul className="mb-2 space-y-1">
              {draft.modelDirs.map((d) => (
                <li key={d} className="flex items-center gap-2 rounded border border-neutral-800 bg-neutral-950/60 px-2 py-1 font-mono text-xs text-neutral-300">
                  <span className="min-w-0 flex-1 truncate" title={d}>{d}</span>
                  <button
                    type="button"
                    onClick={() => patch({ modelDirs: draft.modelDirs.filter((x) => x !== d) })}
                    className="shrink-0 text-neutral-500 transition-colors hover:text-red-400"
                    title="remove"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex gap-2">
            <input
              className={inputCls + ' flex-1'}
              value={newModelDir}
              onChange={(e) => setNewModelDir(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addModelDir()}
              placeholder="path to a folder with models (e.g. D:\models or ~/models)"
            />
            <button
              type="button"
              onClick={addModelDir}
              disabled={!newModelDir.trim()}
              className="shrink-0 rounded-md border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 transition-colors hover:border-neutral-500 disabled:opacity-50"
            >
              Add
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between rounded-md border border-neutral-800 bg-neutral-950/60 p-3">
          <span>
            <span className="block text-sm text-neutral-200">backend</span>
            <span className="block font-mono text-xs text-neutral-500">
              {cfg.backend}
              {cfg.backend === 'cuda' && cfg.cudaMajor ? ` (CUDA ${cfg.cudaMajor})` : ''}
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
          <SettingToggle
            label="Check for updates on start"
            hint="llama-swap and llama.cpp are checked when the app opens."
            value={draft.checkUpdatesOnStart}
            onChange={(v) => patch({ checkUpdatesOnStart: v })}
          />
          <SettingToggle
            label="Start llama-swap when the app starts"
            hint="The server starts with the app (only when the port is free)."
            value={draft.autoStartLlamaSwap}
            onChange={(v) => patch({ autoStartLlamaSwap: v })}
          />
          <SettingToggle
            label="Close to tray"
            hint="Closing the window minimizes to the tray instead of quitting."
            value={draft.closeToTray}
            onChange={(v) => patch({ closeToTray: v })}
          />
          <SettingToggle
            label="Start with system"
            hint="The app starts at login, minimized to the tray."
            value={draft.startWithSystem}
            onChange={(v) => patch({ startWithSystem: v })}
          />
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || !dirty || !(draft.llamaSwapPort > 0) || !draft.installDir.trim()}
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

      {/* App self-update — state is shared with the sidebar (one check per boot). */}
      <section className="mt-4 rounded-lg border border-neutral-800 bg-neutral-900/60 p-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium text-neutral-200">App version</h3>
            <p className="font-mono text-xs text-neutral-500">v{version}</p>
          </div>
          <button
            type="button"
            onClick={() => void checkApp()}
            disabled={checking || installing}
            className={
              'rounded-md border px-3 py-1.5 text-sm transition-colors disabled:opacity-50 ' +
              (checking
                ? 'border-neutral-700 text-neutral-300'
                : release
                  ? 'border-sky-800 text-sky-300 hover:border-sky-600'
                  : error
                    ? 'border-red-800 text-red-300 hover:border-red-600'
                    : 'border-neutral-700 text-neutral-300 hover:border-neutral-500')
            }
          >
            {checking
              ? `Checking… ${checkRemaining}s`
              : release
                ? 'Update available'
                : error
                  ? 'Check failed — retry'
                  : 'Check for update'}
          </button>
        </div>

        {release && (
          <div className="mt-3 rounded-md border border-sky-900 bg-sky-950/30 p-3">
            <p className="text-sm font-medium text-sky-300">v{release.version} available</p>
            {release.notes && (
              <div className="mt-2 max-h-32 overflow-auto rounded bg-neutral-950/60 p-2">
                <pre className="whitespace-pre-wrap font-sans text-xs text-neutral-400">
                  {release.notes}
                </pre>
              </div>
            )}
            {release.installerUrl && (
              <button
                type="button"
                onClick={() => void installApp()}
                disabled={installing}
                className="mt-3 rounded-md bg-sky-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-sky-500 disabled:cursor-wait disabled:opacity-60"
              >
                {installing ? 'Downloading…' : 'Download & install'}
              </button>
            )}
          </div>
        )}

        {progress && installing && <Progress p={progress} />}

        {(error || done) && (
          <p className={'mt-3 text-xs ' + (done ? 'text-emerald-600' : 'text-red-400')}>
            {done ? 'update installed — closing app…' : error}
          </p>
        )}
      </section>
    </>
  )
}
