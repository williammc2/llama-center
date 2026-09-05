import { useState } from 'react'
import type { AppConfig } from '../lib/config'

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
    </>
  )
}
