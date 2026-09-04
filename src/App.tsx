import { useEffect, useState } from 'react'
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
      <main className="flex min-h-screen items-center justify-center bg-neutral-950 px-4 text-neutral-200">
        <div className="mx-auto max-w-xl">
          <h1 className="text-2xl font-semibold tracking-tight">llama-center</h1>
          <p className="mt-3 text-neutral-400">
            Setup complete. Backend: <span className="font-mono text-neutral-200">{cfg.backend}</span>
            {cfg.backend === 'cuda' && (
              <>
                {' · CUDA ' + cfg.cudaMajor} ({cfg.cudaFamily})
              </>
            )}
            {' · port '}
            <span className="font-mono text-neutral-200">{cfg.llamaSwapPort}</span>
          </p>
          <p className="mt-4 text-sm text-neutral-500">
            Home screen (start/stop, logs, updates) lands in P1–P3.
          </p>
        </div>
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
