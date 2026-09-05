import { useEffect, useState, type ReactNode } from 'react'
import { bridge, type SwapModelDef } from '../lib/bridge'
import {
  parseFlagGroups,
  serializeFlagGroups,
  groupHasValues,
  type FlagGroups,
} from '../lib/flagGroups'

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

const selectCls =
  'rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-xs text-neutral-200 focus:border-sky-600 focus:outline-none'

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

/** Update a specific field in the flag groups and serialize back. */
function updateFlags(extraFlags: string, update: (g: FlagGroups) => void): string {
  const g = parseFlagGroups(extraFlags)
  update(g)
  return serializeFlagGroups(g)
}

/** A collapsible flag section with a title and summary. */
function FlagSection({
  title,
  summary,
  open,
  onToggle,
  children,
}: {
  title: string
  summary: string
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <div className="rounded border border-neutral-800 bg-neutral-900/40">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between px-3 py-1.5 text-left"
      >
        <span className="flex items-center gap-2">
          <span className="font-mono text-[10px] text-neutral-500">{open ? '▾' : '▸'}</span>
          <span className="text-xs font-medium text-neutral-300">{title}</span>
          {summary && <span className="font-mono text-[10px] text-neutral-500">{summary}</span>}
        </span>
      </button>
      {open && <div className="px-3 pb-2 pt-1">{children}</div>}
    </div>
  )
}

/** Number input for a flag value. */
function NumInput({
  value,
  onChange,
  step = 1,
  placeholder,
}: {
  value: number | undefined
  onChange: (v: number | undefined) => void
  step?: number
  placeholder?: string
}) {
  return (
    <input
      className={inputCls}
      type="number"
      step={step}
      value={value ?? ''}
      placeholder={placeholder ?? ''}
      onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
    />
  )
}

/** Toggle (checkbox) for a boolean flag. */
function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean | undefined
  onChange: (v: boolean | undefined) => void
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-neutral-300">
      <input
        type="checkbox"
        checked={checked ?? false}
        onChange={(e) => onChange(e.target.checked ? true : undefined)}
        className="h-3.5 w-3.5 rounded border-neutral-700 bg-neutral-950"
      />
      {label}
    </label>
  )
}

/** The llama-swap models editor: one collapsible box per model with
 *  structured flag sections replacing the raw extra_flags textarea. */
export function ModelsPage() {
  const [models, setModels] = useState<SwapModelDef[]>([emptyModel()])
  const [loaded, setLoaded] = useState(false)
  const [importPath, setImportPath] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [open, setOpen] = useState<Record<number, boolean>>({})
  const [sectionOpen, setSectionOpen] = useState<Record<string, boolean>>({})

  useEffect(() => {
    void bridge
      .getLlamaSwapConfig()
      .then((r) => setModels(r.models.length ? r.models : [emptyModel()]))
      .finally(() => setLoaded(true))
  }, [])

  const toggle = (i: number) => setOpen((o) => ({ ...o, [i]: !o[i] }))
  const toggleSection = (key: string) => setSectionOpen((o) => ({ ...o, [key]: !o[key] }))

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

  /** Render the structured flag sections for a model. */
  function renderFlagSections(i: number, m: SwapModelDef) {
    const g = parseFlagGroups(m.extraFlags)
    const has = groupHasValues(g)
    const prefix = `m${i}`

    const sections: {
      key: string
      title: string
      has: boolean
      summary: string
      content: ReactNode
    }[] = []

    // Sampling
    if (has.sampling) {
      sections.push({
        key: `${prefix}-sampling`,
        title: 'Sampling',
        has: true,
        summary: `temp ${g.sampling.temp ?? '—'} · top_p ${g.sampling.topP ?? '—'}`,
        content: (
          <div className="grid grid-cols-4 gap-2">
            <Field label="temp">
              <NumInput
                value={g.sampling.temp}
                step={0.1}
                onChange={(v) => set(i, { extraFlags: updateFlags(m.extraFlags, (gg) => { gg.sampling.temp = v }) })}
              />
            </Field>
            <Field label="top_p">
              <NumInput
                value={g.sampling.topP}
                step={0.05}
                onChange={(v) => set(i, { extraFlags: updateFlags(m.extraFlags, (gg) => { gg.sampling.topP = v }) })}
              />
            </Field>
            <Field label="top_k">
              <NumInput
                value={g.sampling.topK}
                onChange={(v) => set(i, { extraFlags: updateFlags(m.extraFlags, (gg) => { gg.sampling.topK = v }) })}
              />
            </Field>
            <Field label="min_p">
              <NumInput
                value={g.sampling.minP}
                step={0.05}
                onChange={(v) => set(i, { extraFlags: updateFlags(m.extraFlags, (gg) => { gg.sampling.minP = v }) })}
              />
            </Field>
          </div>
        ),
      })
    }

    // Speculative Decoding
    if (has.specDecoding) {
      sections.push({
        key: `${prefix}-spec`,
        title: 'Speculative Decoding',
        has: true,
        summary: g.specDecoding.type ?? '',
        content: (
          <div className="grid grid-cols-2 gap-2">
            <Field label="type">
              <select
                className={selectCls}
                value={g.specDecoding.type ?? ''}
                onChange={(e) =>
                  set(i, { extraFlags: updateFlags(m.extraFlags, (gg) => { gg.specDecoding.type = e.target.value || undefined }) })
                }
              >
                <option value="">(none)</option>
                <option value="draft-mtp">draft-mtp</option>
                <option value="draft-dflash">draft-dflash</option>
                <option value="draft-eagle3">draft-eagle3</option>
                <option value="draft-dspark">draft-dspark</option>
              </select>
            </Field>
            <Field label="n-max">
              <NumInput
                value={g.specDecoding.nMax}
                onChange={(v) => set(i, { extraFlags: updateFlags(m.extraFlags, (gg) => { gg.specDecoding.nMax = v }) })}
              />
            </Field>
          </div>
        ),
      })
    }

    // Flash Attention
    if (has.flashAttention) {
      sections.push({
        key: `${prefix}-flash`,
        title: 'Flash Attention',
        has: true,
        summary: g.flashAttention.enabled == null ? '' : g.flashAttention.enabled ? 'on' : 'off',
        content: (
          <Field label="mode">
            <select
              className={selectCls}
              value={g.flashAttention.enabled == null ? '' : g.flashAttention.enabled ? 'on' : 'off'}
              onChange={(e) =>
                set(i, {
                  extraFlags: updateFlags(m.extraFlags, (gg) => {
                    gg.flashAttention.enabled = e.target.value === '' ? undefined : e.target.value === 'on'
                  }),
                })
              }
            >
              <option value="">(default)</option>
              <option value="on">on</option>
              <option value="off">off</option>
            </select>
          </Field>
        ),
      })
    }

    // KV Cache
    if (has.kvCache) {
      sections.push({
        key: `${prefix}-kv`,
        title: 'KV Cache',
        has: true,
        summary: `${g.kvCache.typeK ?? '—'}/${g.kvCache.typeV ?? '—'}`,
        content: (
          <div className="grid grid-cols-2 gap-2">
            <Field label="type-k">
              <select
                className={selectCls}
                value={g.kvCache.typeK ?? ''}
                onChange={(e) =>
                  set(i, { extraFlags: updateFlags(m.extraFlags, (gg) => { gg.kvCache.typeK = e.target.value || undefined }) })
                }
              >
                <option value="">(default)</option>
                <option value="f32">f32</option>
                <option value="f16">f16</option>
                <option value="bf16">bf16</option>
                <option value="q8_0">q8_0</option>
                <option value="q5_1">q5_1</option>
                <option value="q5_0">q5_0</option>
                <option value="q4_1">q4_1</option>
                <option value="q4_0">q4_0</option>
                <option value="iq4_nl">iq4_nl</option>
              </select>
            </Field>
            <Field label="type-v">
              <select
                className={selectCls}
                value={g.kvCache.typeV ?? ''}
                onChange={(e) =>
                  set(i, { extraFlags: updateFlags(m.extraFlags, (gg) => { gg.kvCache.typeV = e.target.value || undefined }) })
                }
              >
                <option value="">(default)</option>
                <option value="f32">f32</option>
                <option value="f16">f16</option>
                <option value="bf16">bf16</option>
                <option value="q8_0">q8_0</option>
                <option value="q5_1">q5_1</option>
                <option value="q5_0">q5_0</option>
                <option value="q4_1">q4_1</option>
                <option value="q4_0">q4_0</option>
                <option value="iq4_nl">iq4_nl</option>
              </select>
            </Field>
          </div>
        ),
      })
    }

    // Batching
    if (has.batching) {
      sections.push({
        key: `${prefix}-batch`,
        title: 'Batching',
        has: true,
        summary: `parallel ${g.batching.parallel ?? '—'}`,
        content: (
          <div className="grid grid-cols-2 gap-2">
            <Field label="parallel">
              <NumInput
                value={g.batching.parallel}
                onChange={(v) => set(i, { extraFlags: updateFlags(m.extraFlags, (gg) => { gg.batching.parallel = v }) })}
              />
            </Field>
            <Field label="threads-batch">
              <NumInput
                value={g.batching.threadsBatch}
                onChange={(v) => set(i, { extraFlags: updateFlags(m.extraFlags, (gg) => { gg.batching.threadsBatch = v }) })}
              />
            </Field>
          </div>
        ),
      })
    }

    // Reasoning
    if (has.reasoning) {
      sections.push({
        key: `${prefix}-reason`,
        title: 'Reasoning',
        has: true,
        summary: g.reasoning.effort ?? '',
        content: (
          <div className="space-y-2">
            <Toggle
              label="preserve"
              checked={g.reasoning.preserve}
              onChange={(v) => set(i, { extraFlags: updateFlags(m.extraFlags, (gg) => { gg.reasoning.preserve = v }) })}
            />
            <Toggle
              label="jinja"
              checked={g.reasoning.jinja}
              onChange={(v) => set(i, { extraFlags: updateFlags(m.extraFlags, (gg) => { gg.reasoning.jinja = v }) })}
            />
            <Field label="effort">
              <select
                className={selectCls}
                value={g.reasoning.effort ?? ''}
                onChange={(e) =>
                  set(i, { extraFlags: updateFlags(m.extraFlags, (gg) => { gg.reasoning.effort = e.target.value || undefined }) })
                }
              >
                <option value="">(default)</option>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
              </select>
            </Field>
          </div>
        ),
      })
    }

    // Image
    if (has.image) {
      sections.push({
        key: `${prefix}-image`,
        title: 'Image',
        has: true,
        summary: `min-tokens ${g.image.minTokens ?? '—'}`,
        content: (
          <Field label="image-min-tokens">
            <NumInput
              value={g.image.minTokens}
              onChange={(v) => set(i, { extraFlags: updateFlags(m.extraFlags, (gg) => { gg.image.minTokens = v }) })}
            />
          </Field>
        ),
      })
    }

    return (
      <div className="col-span-2 mt-2 space-y-1.5">
        {sections.map((s) => (
          <FlagSection
            key={s.key}
            title={s.title}
            summary={s.summary}
            open={!!sectionOpen[s.key]}
            onToggle={() => toggleSection(s.key)}
          >
            {s.content}
          </FlagSection>
        ))}
        {/* Custom flags — always available */}
        <FlagSection
          title="Custom flags"
          summary={g.custom ? g.custom.slice(0, 40) + (g.custom.length > 40 ? '…' : '') : ''}
          open={!!sectionOpen[`${prefix}-custom`] || has.custom}
          onToggle={() => toggleSection(`${prefix}-custom`)}
        >
          <textarea
            className={inputCls + ' h-14 resize-y'}
            value={g.custom}
            onChange={(e) =>
              set(i, { extraFlags: updateFlags(m.extraFlags, (gg) => { gg.custom = e.target.value }) })
            }
            placeholder="--any-custom-flag value …"
          />
        </FlagSection>
      </div>
    )
  }

  return (
    <>
      <h2 className="text-lg font-semibold text-neutral-100">Models</h2>
      <p className="mt-1 text-sm text-neutral-500">
        The llama-server path is filled in automatically (managed llama.cpp). Flags are
        organized into sections — unknown flags go to Custom.
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
                          placeholder="my-model"
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
                      {renderFlagSections(i, m)}
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
