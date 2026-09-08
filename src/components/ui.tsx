/**
 * Shared UI primitives — the small building blocks that were copy-pasted
 * across pages (input styling, the two toggle flavors).
 *
 * Two toggles on purpose: the settings toggle is a two-state card
 * (`boolean`), the models toggle is a tri-state row (`boolean | undefined` —
 * "unset" means the flag is absent, which is meaningful for llama-server
 * flags where absence = off).
 */

/** Full-width mono input (text/number) — the page-standard field style. */
export const inputCls =
  'w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-xs text-neutral-200 focus:border-sky-600 focus:outline-none'

/** Select in the same field style. */
export const selectCls =
  'rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-xs text-neutral-200 focus:border-sky-600 focus:outline-none'

/** Two-state toggle card (Settings). */
export function SettingToggle({
  label,
  hint,
  value,
  onChange,
}: {
  label: string
  hint: string
  value: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-md border border-neutral-800 bg-neutral-950/60 p-3">
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 accent-sky-600"
      />
      <span>
        <span className="block text-sm text-neutral-200">{label}</span>
        <span className="block text-xs text-neutral-500">{hint}</span>
      </span>
    </label>
  )
}

/** Tri-state flag toggle row (Models). Unchecking goes back to "unset". */
export function FlagToggle({
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
