import { useEffect, useRef, useState } from 'react'
import { bridge, type DownloadProgress } from './bridge'

export type Phase =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'downloading'; message?: string }
  | { status: 'installing'; message?: string }
  | { status: 'done'; message: string }
  | { status: 'error'; message: string }

/**
 * The update lifecycle shared by the Server and llama.cpp pages: phase state,
 * busy flag, the download-progress subscription, and the tray
 * "Check for updates" wiring (previously copy-pasted in both pages).
 * `check` is read through a ref so the tray callback always calls the
 * latest closure, not the one from the first render.
 */
export function useUpdateFlow(check: () => void) {
  const [phase, setPhase] = useState<Phase>({ status: 'idle' })
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<DownloadProgress | null>(null)

  const checkRef = useRef(check)
  checkRef.current = check

  // Tray "Check for updates" lands on the active page.
  useEffect(() => {
    window.__lcCheckUpdates = () => {
      void checkRef.current()
    }
    return () => {
      delete window.__lcCheckUpdates
    }
  }, [])

  // Live download progress (each page only renders it for its own component).
  useEffect(() => {
    let off: (() => void) | undefined
    void bridge.onDownloadProgress(setProgress).then((u) => {
      off = u
    })
    return () => {
      off?.()
    }
  }, [])

  const busyAny =
    busy || phase.status === 'checking' || phase.status === 'downloading' || phase.status === 'installing'
  const phaseLine =
    phase.status === 'downloading' || phase.status === 'installing' ? phase.message ?? null : null

  return { phase, setPhase, busy, setBusy, busyAny, phaseLine, progress }
}
