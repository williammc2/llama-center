import { useEffect, useState, type ReactNode } from 'react'
import { bridge, type SwapModelDef } from '../lib/bridge'
import {
  parseFlagGroups,
  serializeFlagGroups,
  groupHasValues,
  type FlagGroups,
} from '../lib/flagGroups'
import { inputCls, selectCls, FlagToggle } from '../components/ui'
import { Progress } from '../components/Progress'
import { useDownloadProgress } from '../lib/useDownloadProgress'

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

/**
 * A model row in the editor: the bridge shape plus a stable `id`.
 *
 * `id` is local-only (stripped before save). It exists because the list used
 * to key React nodes and the open/section state by ARRAY INDEX — removing
 * model #1 made #2 inherit #1's expanded state and flag sections. A stable
 * id survives reordering/removal. Not part of `SwapModelDef` so the bridge
 * (and Python) never see it.
 */
type ModelRow = SwapModelDef & { id: number }

let nextId = 0
const withId = (m: SwapModelDef): ModelRow => ({ ...m, id: nextId++ })
const stripId = (m: ModelRow): SwapModelDef => {
  const { id: _id, ...rest } = m
  return rest
}

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

/** KV cache quantization options (llama-server --cache-type-k / -v). */
const KV_TYPES = ['', 'f32', 'f16', 'bf16', 'q8_0', 'q5_1', 'q5_0', 'q4_1', 'q4_0', 'iq4_nl']

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

/** Human-readable byte size (GB/MB) for the HF file list. */
function fmtSize(n: number): string {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(1)} GB`
  if (n >= 1 << 20) return `${Math.round(n / (1 << 20))} MB`
  return `${Math.round(n / 1024)} KB`
}

/**
 * "Browse HuggingFace" — paste a repo id, list its .gguf files, download one
 * (or select an already-downloaded one) and fill the model's gguf/mmproj
 * field with the local path.
 *
 * State is local to the picker (repo input, file list, target field,
 * download-in-flight). The download progress rides the shared
 * `useDownloadProgress` channel, filtered to `component === 'model'` so
 * other components' progress never renders here.
 */
function HfPicker({ onSelect }: { onSelect: (field: 'model' | 'mmproj', path: string) => void }) {
  const [repo, setRepo] = useState('')
  const [files, setFiles] = useState<Array<{ name: string; size: number; downloaded?: boolean; localPath?: string }>>([])
  const [target, setTarget] = useState<'model' | 'mmproj'>('model')
  const [loading, setLoading] = useState(false)
  const [downloading, setDownloading] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const progress = useDownloadProgress((p) => p.component === 'model')

  const browse = async () => {
    const id = repo.trim()
    if (!id) return
    setLoading(true)
    setErr('')
    setFiles([])
    const res = await bridge.listHfFiles(id)
    if (res.error) setErr(res.error)
    else setFiles(res.files ?? [])
    setLoading(false)
  }

  const download = async (f: { name: string; downloaded?: boolean; localPath?: string }) => {
    const id = repo.trim()
    if (f.downloaded && f.localPath) {
      // Already on disk: confirm before re-downloading (overwrites the file).
      // "No" = just select the existing copy.
      if (!window.confirm(`${f.name} is already downloaded.\n\nOK = re-download (overwrites)\nCancel = use the existing file`)) {
        onSelect(target, f.localPath)
        return
      }
    }
    setDownloading(f.name)
    setErr('')
    const res = await bridge.downloadHfFile(id, f.name)
    if (res.error) setErr(res.error)
    else if (res.path) {
      // Mark it done in the list so the button flips to "done" (no re-click
      // surprise) — the next Browse re-detects from disk anyway.
      setFiles((fs) => fs.map((x) => (x.name === f.name ? { ...x, downloaded: true, localPath: res.path } : x)))
      onSelect(target, res.path)
    }
    setDownloading(null)
  }

  return (
    <div className="mt-2 rounded border border-neutral-800 bg-neutral-900/40 p-2">
      <div className="flex gap-2">
        <input
          className={inputCls + ' flex-1'}
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void browse()
          }}
          placeholder="HuggingFace repo: org/model (e.g. Qwen/Qwen2.5-7B-Instruct-GGUF)"
        />
        <button
          type="button"
          onClick={() => void browse()}
          disabled={loading || !repo.trim()}
          className="rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 transition-colors hover:border-neutral-500 disabled:opacity-50"
        >
          {loading ? '…' : 'Browse'}
        </button>
      </div>
      {files.length > 0 && (
        <div className="mt-2 flex items-center gap-2 text-xs">
          <span className="text-neutral-500">fill field:</span>
          {(['model', 'mmproj'] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setTarget(f)}
              className={
                'rounded border px-2 py-0.5 font-mono transition-colors ' +
                (target === f
                  ? 'border-sky-600 text-sky-300'
                  : 'border-neutral-700 text-neutral-400 hover:border-neutral-500')
              }
            >
              {f === 'model' ? 'model (.gguf)' : 'mmproj'}
            </button>
          ))}
        </div>
      )}
      {err && <p className="mt-1 text-xs text-red-400">{err}</p>}
      {files.length > 0 && (
        <ul className="mt-2 max-h-40 space-y-0.5 overflow-auto">
          {files.map((f) => (
            <li key={f.name} className="flex items-center gap-2 font-mono text-xs">
              <span className="min-w-0 flex-1 truncate text-neutral-300" title={f.name}>
                {f.name}
              </span>
              <span className="shrink-0 text-neutral-500">{fmtSize(f.size)}</span>
              <button
                type="button"
                onClick={() => void download(f)}
                disabled={downloading !== null}
                title={f.downloaded ? 'already downloaded — click to re-download or select' : 'download'}
                className={
                  'shrink-0 rounded border px-2 py-0.5 transition-colors disabled:opacity-50 ' +
                  (f.downloaded
                    ? 'border-emerald-700 text-emerald-400 hover:border-emerald-500'
                    : 'border-neutral-700 text-neutral-300 hover:border-sky-600')
                }
              >
                {downloading === f.name ? '…' : f.downloaded ? 'done' : '↓'}
              </button>
            </li>
          ))}
        </ul>
      )}
      {progress && <Progress p={progress} />}
    </div>
  )
}

/** The llama-swap models editor: one collapsible box per model with
 *  structured flag sections replacing the raw extra_flags textarea. */
export function ModelsPage() {
  const [models, setModels] = useState<ModelRow[]>([withId(emptyModel())])
  const [loaded, setLoaded] = useState(false)
  const [importPath, setImportPath] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  // Expanded state is keyed by the model's stable `id` (not its array index —
  // removing a model must not make the next one inherit its open state).
  const [open, setOpen] = useState<Record<number, boolean>>({})
  const [sectionOpen, setSectionOpen] = useState<Record<string, boolean>>({})
  // Which model's HuggingFace picker is open (one at a time, by stable id).
  const [hfOpen, setHfOpen] = useState<number | null>(null)

  useEffect(() => {
    void bridge
      .getLlamaSwapConfig()
      .then((r) => setModels(r.models.length ? r.models.map(withId) : [withId(emptyModel())]))
      .finally(() => setLoaded(true))
  }, [])

  const toggle = (id: number) => setOpen((o) => ({ ...o, [id]: !o[id] }))
  const toggleSection = (key: string) => setSectionOpen((o) => ({ ...o, [key]: !o[key] }))

  const set = (id: number, patch: Partial<SwapModelDef>) =>
    setModels((ms) => ms.map((m) => (m.id === id ? { ...m, ...patch } : m)))

  const allErrors = models.map((m) => modelErrors(m, models))
  const hasErrors = allErrors.some((e) => Object.keys(e).length > 0)
  const hasModel = models.some((m) => m.name.trim() || m.model.trim())
  // Errors keyed by the model's stable id (allErrors is index-aligned with
  // models; a Map lets render look them up without the index).
  const errorsById = new Map(models.map((m, i) => [m.id, allErrors[i]]))

  const save = async () => {
    setSaving(true)
    setMsg(null)
    try {
      const res = await bridge.saveLlamaSwapConfig(
        models.filter((m) => m.name.trim()).map(stripId),
      )
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
      setModels(res.models.map(withId))
      setMsg({ kind: 'ok', text: `imported ${res.models.length} model(s) — review and save` })
    }
  }

  /** Render the structured flag sections for a model. */
  function renderFlagSections(m: ModelRow) {
    const g = parseFlagGroups(m.extraFlags)
    const has = groupHasValues(g)
    const prefix = `m${m.id}`

    const sections: { key: string; title: string; summary: string; content: ReactNode }[] = []

    // Sampling
    if (has.sampling) {
      sections.push({
        key: `${prefix}-sampling`,
        title: 'Sampling',
        summary: `temp ${g.sampling.temp ?? '—'} · top_p ${g.sampling.topP ?? '—'}`,
        content: (
          <div className="grid grid-cols-4 gap-2">
            <Field label="temp">
              <NumInput
                value={g.sampling.temp}
                step={0.1}
                onChange={(v) => set(m.id, { extraFlags: updateFlags(m.extraFlags, (gg) => { gg.sampling.temp = v }) })}
              />
            </Field>
            <Field label="top_p">
              <NumInput
                value={g.sampling.topP}
                step={0.05}
                onChange={(v) => set(m.id, { extraFlags: updateFlags(m.extraFlags, (gg) => { gg.sampling.topP = v }) })}
              />
            </Field>
            <Field label="top_k">
              <NumInput
                value={g.sampling.topK}
                onChange={(v) => set(m.id, { extraFlags: updateFlags(m.extraFlags, (gg) => { gg.sampling.topK = v }) })}
              />
            </Field>
            <Field label="min_p">
              <NumInput
                value={g.sampling.minP}
                step={0.05}
                onChange={(v) => set(m.id, { extraFlags: updateFlags(m.extraFlags, (gg) => { gg.sampling.minP = v }) })}
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
        summary: g.specDecoding.type ?? '',
        content: (
          <div className="grid grid-cols-2 gap-2">
            <Field label="type">
              <select
                className={selectCls}
                value={g.specDecoding.type ?? ''}
                onChange={(e) =>
                  set(m.id, { extraFlags: updateFlags(m.extraFlags, (gg) => { gg.specDecoding.type = e.target.value || undefined }) })
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
                onChange={(v) => set(m.id, { extraFlags: updateFlags(m.extraFlags, (gg) => { gg.specDecoding.nMax = v }) })}
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
        summary: g.flashAttention.enabled == null ? '' : g.flashAttention.enabled ? 'on' : 'off',
        content: (
          <Field label="mode">
            <select
              className={selectCls}
              value={g.flashAttention.enabled == null ? '' : g.flashAttention.enabled ? 'on' : 'off'}
              onChange={(e) =>
                set(m.id, {
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
        summary: `${g.kvCache.typeK ?? '—'}/${g.kvCache.typeV ?? '—'}`,
        content: (
          <div className="grid grid-cols-2 gap-2">
            <Field label="type-k">
              <select
                className={selectCls}
                value={g.kvCache.typeK ?? ''}
                onChange={(e) =>
                  set(m.id, { extraFlags: updateFlags(m.extraFlags, (gg) => { gg.kvCache.typeK = e.target.value || undefined }) })
                }
              >
                {KV_TYPES.map((v) => (
                  <option key={v} value={v}>{v === '' ? '(default)' : v}</option>
                ))}
              </select>
            </Field>
            <Field label="type-v">
              <select
                className={selectCls}
                value={g.kvCache.typeV ?? ''}
                onChange={(e) =>
                  set(m.id, { extraFlags: updateFlags(m.extraFlags, (gg) => { gg.kvCache.typeV = e.target.value || undefined }) })
                }
              >
                {KV_TYPES.map((v) => (
                  <option key={v} value={v}>{v === '' ? '(default)' : v}</option>
                ))}
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
        summary: `parallel ${g.batching.parallel ?? '—'}`,
        content: (
          <div className="grid grid-cols-2 gap-2">
            <Field label="parallel">
              <NumInput
                value={g.batching.parallel}
                onChange={(v) => set(m.id, { extraFlags: updateFlags(m.extraFlags, (gg) => { gg.batching.parallel = v }) })}
              />
            </Field>
            <Field label="threads-batch">
              <NumInput
                value={g.batching.threadsBatch}
                onChange={(v) => set(m.id, { extraFlags: updateFlags(m.extraFlags, (gg) => { gg.batching.threadsBatch = v }) })}
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
        summary: g.reasoning.effort ?? '',
        content: (
          <div className="space-y-2">
            <FlagToggle
              label="preserve"
              checked={g.reasoning.preserve}
              onChange={(v) => set(m.id, { extraFlags: updateFlags(m.extraFlags, (gg) => { gg.reasoning.preserve = v }) })}
            />
            <FlagToggle
              label="jinja"
              checked={g.reasoning.jinja}
              onChange={(v) => set(m.id, { extraFlags: updateFlags(m.extraFlags, (gg) => { gg.reasoning.jinja = v }) })}
            />
            <Field label="effort">
              <select
                className={selectCls}
                value={g.reasoning.effort ?? ''}
                onChange={(e) =>
                  set(m.id, { extraFlags: updateFlags(m.extraFlags, (gg) => { gg.reasoning.effort = e.target.value || undefined }) })
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
        summary: `min-tokens ${g.image.minTokens ?? '—'}`,
        content: (
          <Field label="image-min-tokens">
            <NumInput
              value={g.image.minTokens}
              onChange={(v) => set(m.id, { extraFlags: updateFlags(m.extraFlags, (gg) => { gg.image.minTokens = v }) })}
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
              set(m.id, { extraFlags: updateFlags(m.extraFlags, (gg) => { gg.custom = e.target.value }) })
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
          {models.map((m) => {
            const errs = errorsById.get(m.id) ?? {}
            const hasErr = Object.keys(errs).length > 0
            return (
              <div key={m.id} className="rounded border border-neutral-800 bg-neutral-950/60">
                <div className="flex items-center justify-between gap-2 px-3 py-2">
                  <button
                    type="button"
                    onClick={() => toggle(m.id)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <span className="font-mono text-xs text-neutral-500">{open[m.id] ? '▾' : '▸'}</span>
                    <span className="truncate font-mono text-xs text-neutral-300">
                      {m.name || `model #${models.indexOf(m) + 1}`}
                      {m.model && <span className="text-neutral-600"> · {m.model}</span>}
                    </span>
                    {hasErr && (
                      <span className="h-2 w-2 shrink-0 rounded-full bg-red-500" title="has validation errors" />
                    )}
                  </button>
                  {models.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setModels((ms) => ms.filter((x) => x.id !== m.id))}
                      className="text-xs text-neutral-500 transition-colors hover:text-red-400"
                    >
                      remove
                    </button>
                  )}
                </div>
                {open[m.id] && (
                  <div className="px-3 pb-3">
                    <div className="mt-1 grid grid-cols-2 gap-2">
                      <Field label="name" error={errs.name}>
                        <input
                          className={inputCls}
                          value={m.name}
                          onChange={(e) => set(m.id, { name: e.target.value })}
                          placeholder="my-model"
                        />
                      </Field>
                      <Field label="ctx-size" error={errs.ctxSize}>
                        <input
                          className={inputCls}
                          type="number"
                          value={m.ctxSize}
                          onChange={(e) => set(m.id, { ctxSize: Number(e.target.value) })}
                        />
                      </Field>
                      <div className="col-span-2">
                        <Field label="model (.gguf)" error={errs.model}>
                          <div className="flex gap-2">
                            <input
                              className={inputCls + ' flex-1'}
                              value={m.model}
                              onChange={(e) => set(m.id, { model: e.target.value })}
                              placeholder="D:\models\....gguf"
                            />
                            <button
                              type="button"
                              onClick={() => setHfOpen(hfOpen === m.id ? null : m.id)}
                              className={
                                'shrink-0 rounded-md border px-3 py-1.5 text-xs transition-colors ' +
                                (hfOpen === m.id
                                  ? 'border-sky-600 text-sky-300'
                                  : 'border-neutral-700 text-neutral-300 hover:border-neutral-500')
                              }
                            >
                              Browse HF
                            </button>
                          </div>
                        </Field>
                      </div>
                      <Field label="mmproj (optional)">
                        <input
                          className={inputCls}
                          value={m.mmproj ?? ''}
                          onChange={(e) => set(m.id, { mmproj: e.target.value || null })}
                        />
                      </Field>
                      <Field label="draft model (optional)">
                        <input
                          className={inputCls}
                          value={m.draft ?? ''}
                          onChange={(e) => set(m.id, { draft: e.target.value || null })}
                        />
                      </Field>
                      <Field label="gpu-layers" error={errs.gpuLayers}>
                        <input
                          className={inputCls}
                          type="number"
                          value={m.gpuLayers}
                          onChange={(e) => set(m.id, { gpuLayers: Number(e.target.value) })}
                        />
                      </Field>
                      <Field label="threads (optional)" error={errs.threads}>
                        <input
                          className={inputCls}
                          type="number"
                          value={m.threads ?? ''}
                          onChange={(e) =>
                            set(m.id, { threads: e.target.value === '' ? null : Number(e.target.value) })
                          }
                        />
                      </Field>
                      {renderFlagSections(m)}
                    </div>
                    {hfOpen === m.id && (
                      <HfPicker
                        onSelect={(field, path) => set(m.id, field === 'model' ? { model: path } : { mmproj: path })}
                      />
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setModels((ms) => [...ms, withId(emptyModel())])}
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
