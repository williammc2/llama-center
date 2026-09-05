import { useEffect, useState } from 'react'
import { Shell } from './components/Shell'
import { Wizard } from './components/Wizard'
import { bridge } from './lib/bridge'
import type { AppConfig } from './lib/config'
import type { Detection } from './lib/detect'

type Ready =
  | { status: 'loading' }
  | { status: 'ready'; cfg: AppConfig | null; detection: Detection }
  | { status: 'no-backend'; error: string }

export default function App() {
  const [state, setState] = useState<Ready>({ status: 'loading' })
  const [reconfiguring, setReconfiguring] = useState(false)
  const [cfg, setCfg] = useState<AppConfig | null>(null)

  useEffect(() => {
    let alive = true
    // pywebview injects the API asynchronously — wait for it when present,
    // but never hang (browser mode resolves immediately).
    const waitForApi = async () => {
      const started = Date.now()
      while (window.pywebview?.api === undefined && Date.now() - started < 3000) {
        await new Promise((r) => setTimeout(r, 50))
      }
    }
    ;(async () => {
      await waitForApi()
      if (window.pywebview?.api === undefined) {
        // The Python API never arrived — the browser stub would silently
        // take over (localStorage config, fake detection) and the app would
        // look alive while every action fails. Better to say so.
        if (!alive) return
        setState({ status: 'no-backend', error: 'The Python backend never responded. Close and reopen the app.' })
        return
      }
      try {
        const [cfg, detection] = await Promise.all([bridge.getConfig(), bridge.getDetection()])
        if (!alive) return
        setCfg(cfg)
        setState({ status: 'ready', cfg, detection })
      } catch (e) {
        // Corrupt config: show the wizard with a notice instead of crashing.
        if (!alive) return
        const detection = await bridge.getDetection().catch(() => null)
        if (detection) setState({ status: 'ready', cfg: null, detection })
        console.error(e)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const saveConfig = async (next: AppConfig) => {
    await bridge.saveConfig(next)
    setCfg(next)
  }

  if (state.status === 'loading') {
    return (
      <main className="flex min-h-screen items-center justify-center bg-neutral-950 text-neutral-500">
        <p className="text-sm">Loading…</p>
      </main>
    )
  }

  if (state.status === 'no-backend') {
    return (
      <main className="flex min-h-screen items-center justify-center bg-neutral-950 px-4 text-neutral-500">
        <div className="text-center">
          <p className="text-2xl">⚠️</p>
          <p className="mt-3 text-sm font-medium text-neutral-300">Backend not responding</p>
          <p className="mt-1 max-w-xs text-xs text-neutral-500">{state.error}</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-4 rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 transition-colors hover:border-neutral-500"
          >
            Retry
          </button>
        </div>
      </main>
    )
  }

  const { detection } = state

  const showWizard = reconfiguring || !cfg?.firstRunDone

  if (showWizard) {
    return (
      <main className="flex min-h-screen items-start justify-center bg-neutral-950 px-4 py-12 text-neutral-200">
        <Wizard
          detection={detection}
          initial={cfg ?? undefined}
          onSaved={() => {
            // Re-read from the bridge to reflect the saved config.
            window.location.reload()
          }}
          onBack={reconfiguring && cfg ? () => setReconfiguring(false) : undefined}
        />
      </main>
    )
  }

  return <Shell cfg={cfg} detection={detection} onSaveConfig={saveConfig} onReconfigure={() => setReconfiguring(true)} />
}
