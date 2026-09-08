import { useCallback, useEffect, useRef, useState } from 'react'
import { bridge } from './bridge'
import { errText } from './errors'
import type { Phase } from './useUpdateFlow'

/**
 * The per-component update cycle shared by the Server and llama.cpp pages:
 * the backup list (refreshed on mount), the rollback, and the rollback
 * button label.
 *
 * Phase and busy state are owned by `useUpdateFlow` — the setters are passed
 * in so the two hooks compose without a shared context. `onRollback` receives
 * the version token captured from the newest backup dir name (`m[1]` of
 * `versionPattern`: digits for `/v(\d+)/`, digits for `/b(\d+)/`) and is read
 * through a ref, so it always sees the latest cfg.
 */
export function useComponentUpdate(
  component: string,
  setPhase: (p: Phase) => void,
  setBusy: (b: boolean) => void,
  versionPattern: RegExp,
  onRollback: (version: string) => Promise<void>,
) {
  const [backups, setBackups] = useState<string[]>([])

  const onRollbackRef = useRef(onRollback)
  onRollbackRef.current = onRollback
  const patternRef = useRef(versionPattern)
  patternRef.current = versionPattern

  const refresh = useCallback(async () => {
    setBackups(await bridge.listComponentBackups(component))
  }, [component])

  // Fresh backup list on mount (both pages did this in their boot effect).
  useEffect(() => {
    void refresh()
  }, [refresh])

  const rollback = useCallback(async () => {
    const newest = backups[0]
    if (!newest) return
    setBusy(true)
    try {
      const ok = await bridge.rollbackComponent(component)
      if (!ok) {
        setPhase({ status: 'error', message: 'no backups to roll back to' })
        return
      }
      const m = patternRef.current.exec(newest)
      const version = m?.[1]
      if (version) await onRollbackRef.current(version)
      setPhase({ status: 'done', message: `rolled back to ${newest}` })
      await refresh()
    } catch (e) {
      setPhase({ status: 'error', message: errText(e, 'rollback failed') })
    } finally {
      setBusy(false)
    }
  }, [backups, component, setPhase, setBusy, refresh])

  // `m[0]` keeps the prefix ("v1" / "b2590") for the button label.
  const first = backups[0]
  const m = first ? patternRef.current.exec(first) : null
  const rollbackLabel = m ? `Rollback → ${m[0]}` : 'Rollback'

  return { backups, refresh, rollback, rollbackLabel }
}
