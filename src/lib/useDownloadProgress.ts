import { useEffect, useRef, useState } from 'react'
import { bridge, type DownloadProgress } from './bridge'

/**
 * Subscribe to the Python download-progress pushes.
 *
 * `bridge.onDownloadProgress` is async (pywebview wires the push channel on
 * the first call), so the unsubscribe must be captured once the promise
 * settles — and the effect cleanup must survive an unmount that happens
 * BEFORE it does. This dance was copy-pasted in three places (useAppUpdate,
 * useUpdateFlow and the pages); it lives here now.
 *
 * `filter` narrows which updates land (the app installer only wants
 * `component === 'app'`); it is read through a ref so the subscription is
 * set up once and never re-wired.
 */
export function useDownloadProgress(filter?: (p: DownloadProgress) => boolean): DownloadProgress | null {
  const [progress, setProgress] = useState<DownloadProgress | null>(null)
  const filterRef = useRef(filter)
  filterRef.current = filter

  useEffect(() => {
    let off: (() => void) | undefined
    void bridge
      .onDownloadProgress((p) => {
        if (!filterRef.current || filterRef.current(p)) setProgress(p)
      })
      .then((u) => {
        off = u
      })
    return () => {
      off?.()
    }
  }, [])

  return progress
}
