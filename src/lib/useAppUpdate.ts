import { useCallback, useEffect, useState } from 'react'
import { bridge, type DownloadProgress } from './bridge'
import { checkAppUpdate, type AppRelease } from './appUpdate'

/**
 * App self-update state, shared by the sidebar (Shell) and Settings.
 *
 * The check runs ONCE per boot, in the background: the sidebar shows the app
 * version permanently and flips its status line to "update available" when
 * the check settles. Failures are non-fatal — the status line just goes
 * quiet (or shows the error in Settings on a manual retry).
 */
export interface AppUpdateState {
  /** The running app's version (VITE_APP_VERSION). */
  version: string
  /** Latest release newer than the running one, once known. */
  release: AppRelease | null
  /** A check (auto or manual) is in flight. */
  checking: boolean
  /** The installer download/launch is in flight. */
  installing: boolean
  /** Last check error (manual retry shows it; auto check stays quiet). */
  error: string | null
  /** Set true after a successful install launch — the app is about to close. */
  done: boolean
  /** Live download progress while installing (component 'app'). */
  progress: DownloadProgress | null
  /** When the in-flight check started (null when idle) — for the countdown. */
  checkStartedAt: number | null
  /** Force a re-check (Settings "Check for update" button). */
  check: () => Promise<void>
  /** Download the installer and launch it. */
  install: () => Promise<void>
}

export function useAppUpdate(): AppUpdateState {
  const version = import.meta.env.VITE_APP_VERSION
  const [release, setRelease] = useState<AppRelease | null>(null)
  const [checking, setChecking] = useState(false)
  const [checkStartedAt, setCheckStartedAt] = useState<number | null>(null)
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [progress, setProgress] = useState<DownloadProgress | null>(null)

  const check = useCallback(async () => {
    setChecking(true)
    setCheckStartedAt(Date.now())
    setError(null)
    try {
      setRelease(await checkAppUpdate(version))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'check failed')
    } finally {
      setChecking(false)
      setCheckStartedAt(null)
    }
  }, [version])

  // Silent check once per boot — never blocks the UI, never throws.
  useEffect(() => {
    void check()
  }, [check])

  const install = useCallback(async () => {
    if (!release?.installerUrl) return
    setInstalling(true)
    setError(null)
    setDone(false)
    try {
      const res = await bridge.downloadAndLaunchInstaller(release.installerUrl)
      setDone(!!res.closing || !!res.launched)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'install failed')
    } finally {
      setInstalling(false)
    }
  }, [release])

  // Subscribe to download progress for the app installer.
  useEffect(() => {
    let off: (() => void) | undefined
    void bridge.onDownloadProgress((p) => {
      if (p.component === 'app') setProgress(p)
    }).then((u) => {
      off = u
    })
    return () => {
      off?.()
    }
  }, [])

  return {
    version,
    release,
    checking,
    installing,
    error,
    done,
    progress,
    checkStartedAt,
    check,
    install,
  }
}
