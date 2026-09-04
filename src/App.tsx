import { useMemo } from 'react'
import { Wizard } from './components/Wizard'
import { detectFromNavigator } from './lib/detect'
import { parseConfig, type AppConfig } from './lib/config'

const CONFIG_KEY = 'llama-center:config'

function loadConfig(): AppConfig | null {
  try {
    const raw = localStorage.getItem(CONFIG_KEY)
    if (!raw) return null
    return parseConfig(JSON.parse(raw))
  } catch {
    return null
  }
}

export default function App() {
  const detection = useMemo(() => detectFromNavigator(navigator), [])
  const cfg = loadConfig()

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
          // Re-read to reflect the saved config.
          window.location.reload()
        }}
      />
    </main>
  )
}
