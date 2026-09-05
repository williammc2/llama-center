import { useEffect, useState, type ReactNode } from 'react'
import { bridge, type SwapModelDef } from '../lib/bridge'

const emptyModel = (): SwapModelDef => ({
  name: '',
  model: '',
  mmproj: null,
  draft: null,
  ctxSize: 8192,
  gpuLayers: 999,
  threads: null,
  extraFlags: '',
})

function modelErrors(m: SwapModelDef, all: SwapModelDef[]): Record<string, string> {
  const e: Record<string, string> = {}
  if (!m.name.trim()) e.name = 'required'
  else if (all.some((x) => x !== m && x.name === m.name)) e.name = 'duplicate name'
  if (!m.model.trim()) e.model = 'required'
  if (!(m.ctxSize > 0)) e.ctxSize = 'must be > 0'
  if (!(m.gpuLayers > 0)) e.gpuLayers = 'must be > 0'
  if (m.threads != null && !(m.threads > 0)) e.threads = 'must be > 0'
  return e
}

const inputCls =
  'w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-xs text-neutral-200 focus:border-sky-600 focus:outline-none'

function Field({ label, error, children }: { label: string; error?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 flex items-center gap-2 text-xs text-neutral-500">
        {label}
        {error && <span className="text-red-400">{error}</span>}
      </span>
      {children}
    </label>
  )
}

/** The llama-swap models editor: one collapsible box per model. The app
 *  renders the `cmd` line (llama-server path abstracted to the managed
 *  llama.cpp); extra flags are appended verbatim. */
export function ModelsPage() {
  const [models, setModels] = useState<SwapModelDef[]>([emptyModel()])
  const [loaded, setLoaded] = useState(false)
  const [importPath, setImportPath] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [open, setOpen] = useState<Record<number, boolean>>({})

  useEffect(() => {
    void bridge
      .getLlamaSwapConfig()
      .then((r) => setModels(r.models.length ? r.models : [emptyModel()]))
      .finally(() => setLoaded(true))
  }, [])

  const toggle = (i: number) => setOpen((o) => ({ ...o, [i]: !o[i] }))

  const set = (i: number, patch: Partial<SwapModelDef>) =>
    setModels((ms) => ms.map((m, j) => (j === i ? { ...m, ...patch } : m)))

  const allErrors = models.map((m) => modelErrors(m, models))
  const hasErrors = allErrors.some((e) => Object.keys(e).length > 0)
  const hasModel = models.some((m) => m.name.trim() || m.model.trim())

  const save = async () => {
    setSaving(true)
    setMsg(null)
    try {
      const res = await bridge.saveLlamaSwapConfig(models.filter((m) => m.name.trim()))
      if (res.error) setMsg({ kind: 'err', text: res.error })
      else setMsg({ kind: 'ok', text: `saved → ${res.path}` })
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : 'save failed' })
    } finally {
      setSaving(false)
    }
  }

  const doImport = async () => {
    setMsg(null)
    const res = await bridge.importLlamaSwapConfig(importPath.trim())
    if (res.error) setMsg({ kind: 'err', text: res.error })
    else if (res.models) {
      setModels(res.models)
      setMsg({ kind: 'ok', text: `imported ${res.models.length} model(s) — review and save` })
    }
  }

  return (
    <>
      <h2 className="text-lg font-semibold text-neutral-100">Models</h2>
      <p className="mt-1 text-sm text-neutral-500">
        The llama-server path is filled in automatically (managed llama.cpp). Extra flags are
        appended verbatim (spec decoding, sampling…).
      </p>

      <section className="mt-4 rounded-lg border border-neutral-800 bg-neutral-900/60 p-4">
        <div className="space-y-3">
          {models.map((m, i) => {
            const errs = allErrors[i]
            const hasErr = Object.keys(errs).length > 0
            return (
              <div key={i} className="rounded border border-neutral-800 bg-neutral-950/60">
                <div className="flex items-center justify-between gap-2 px-3 py-2">
                  <button
                    type="button"
                    onClick={() => toggle(i)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <span className="font-mono text-xs text-neutral-500">{open[i] ? '▾' : '▸'}</span>
                    <span className="truncate font-mono text-xs text-neutral-300">
                      {m.name || `model #${i + 1}`}
                      {m.model && <span className="text-neutral-600"> · {m.model}</span>}
                    </span>
                    {hasErr && (
                      <span className="h-2 w-2 shrink-0 rounded-full bg-red-500" title="has validation errors" />
                    )}
                  </button>
                  {models.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setModels((ms) => ms.filter((_, j) => j !== i))}
                      className="text-xs text-neutral-500 transition-colors hover:text-red-400"
                    >
                      remove
                    </button>
                  )}
                </div>
                {open[i] && (
                  <div className="px-3 pb-3">
                    <div className="mt-1 grid grid-cols-2 gap-2">
                      <Field label="name" error={errs.name}>
                        <input
                          className={inputCls}
                          value={m.name}
                          onChange={(e) => set(i, { name: e.target.value })}
                          placeholder="qwen3.8-27b"
                        />
                      </Field>
                      <Field label="ctx-size" error={errs.ctxSize}>
                        <input
                          className={inputCls}
                          type="number"
                          value={m.ctxSize}
                          onChange={(e) => set(i, { ctxSize: Number(e.target.value) })}
                        />
                      </Field>
                      <div className="col-span-2">
                        <Field label="model (.gguf)" error={errs.model}>
                          <input
                            className={inputCls}
                            value={m.model}
                            onChange={(e) => set(i, { model: e.target.value })}
                            placeholder="D:\models\....gguf"
                          />
                        </Field>
                      </div>
                      <Field label="mmproj (optional)">
                        <input
                          className={inputCls}
                          value={m.mmproj ?? ''}
                          onChange={(e) => set(i, { mmproj: e.target.value || null })}
                        />
                      </Field>
                      <Field label="draft model (optional)">
                        <input
                          className={inputCls}
                          value={m.draft ?? ''}
                          onChange={(e) => set(i, { draft: e.target.value || null })}
                        />
                      </Field>
                      <Field label="gpu-layers" error={errs.gpuLayers}>
                        <input
                          className={inputCls}
                          type="number"
                          value={m.gpuLayers}
                          onChange={(e) => set(i, { gpuLayers: Number(e.target.value) })}
                        />
                      </Field>
                      <Field label="threads (optional)" error={errs.threads}>
                        <input
                          className={inputCls}
                          type="number"
                          value={m.threads ?? ''}
                          onChange={(e) =>
                            set(i, { threads: e.target.value === '' ? null : Number(e.target.value) })
                          }
                        />
                      </Field>
                      <div className="col-span-2">
                        <Field label="extra flags (optional)">
                          <textarea
                            className={inputCls + ' h-16 resize-y'}
                            value={m.extraFlags}
                            onChange={(e) => set(i, { extraFlags: e.target.value })}
                            placeholder={'--flash-attn on\n--spec-type draft-mtp ...'}
                          />
                        </Field>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setModels((ms) => [...ms, emptyModel()])}
            className="rounded-md border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 transition-colors hover:border-neutral-500"
          >
            + Add model
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || !loaded || hasErrors || !hasModel}
            className="rounded-md bg-emerald-700 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-emerald-600 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save config'}
          </button>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            className={inputCls + ' max-w-[320px]'}
            value={importPath}
            onChange={(e) => setImportPath(e.target.value)}
            placeholder="import from: D:\llama-swap\config.yaml"
          />
          <button
            type="button"
            onClick={() => void doImport()}
            disabled={!importPath.trim()}
            className="rounded-md border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 transition-colors hover:border-neutral-500 disabled:opacity-50"
          >
            Import
          </button>
        </div>

        {msg && (
          <p className={'mt-2 text-xs ' + (msg.kind === 'ok' ? 'text-emerald-600' : 'text-red-400')}>
            {msg.text}
          </p>
        )}
      </section>
    </>
  )
}
