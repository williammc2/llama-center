import { useEffect, useState } from 'react'
import { Home } from './components/Home'
import { Wizard } from './components/Wizard'
import { bridge } from './lib/bridge'
import type { AppConfig } from './lib/config'
import type { Detection } from './lib/detect'

type Ready =
  | { status: 'loading' }
  | { status: 'ready'; cfg: AppConfig | null; detection: Detection }

export default function App() {
  const [state, setState] = useState<Ready>({ status: 'loading' })

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
      try {
        const [cfg, detection] = await Promise.all([bridge.getConfig(), bridge.getDetection()])
        if (alive) setState({ status: 'ready', cfg, detection })
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

  if (state.status === 'loading') {
    return (
      <main className="flex min-h-screen items-center justify-center bg-neutral-950 text-neutral-500">
        <p className="text-sm">Loading…</p>
      </main>
    )
  }

  const { cfg, detection } = state

  if (cfg?.firstRunDone) {
    return (
      <main className="min-h-screen bg-neutral-950 px-4 py-12 text-neutral-200">
        <Home cfg={cfg} detection={detection} />
      </main>
    )
  }

  return (
    <main className="flex min-h-screen items-start justify-center bg-neutral-950 px-4 py-12 text-neutral-200">
      <Wizard
        detection={detection}
        onSaved={() => {
          // Re-read from the bridge to reflect the saved config.
          window.location.reload()
        }}
      />
    </main>
  )
}
