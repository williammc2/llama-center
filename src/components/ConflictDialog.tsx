export interface DialogAction {
  label: string
  onClick: () => void
}

/**
 * A three-action modal (primary / secondary / cancel). Used by the Server
 * page for the port-in-use conflict on start and on update.
 */
export function ConflictDialog({
  title,
  body,
  primary,
  secondary,
  cancel,
}: {
  title: string
  body: string
  primary: DialogAction
  secondary: DialogAction
  cancel: DialogAction
}) {
  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/60 px-4">
      <div className="w-full max-w-md rounded-lg border border-neutral-700 bg-neutral-900 p-5">
        <h3 className="text-sm font-medium text-neutral-200">{title}</h3>
        <p className="mt-2 text-sm text-neutral-400">{body}</p>
        <div className="mt-4 flex flex-col gap-2">
          <button
            type="button"
            onClick={primary.onClick}
            className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-500"
          >
            {primary.label}
          </button>
          <button
            type="button"
            onClick={secondary.onClick}
            className="rounded-md border border-neutral-700 px-4 py-2 text-sm text-neutral-300 transition-colors hover:border-neutral-500"
          >
            {secondary.label}
          </button>
          <button
            type="button"
            onClick={cancel.onClick}
            className="rounded-md border border-neutral-700 px-4 py-2 text-sm text-neutral-300 transition-colors hover:border-neutral-500"
          >
            {cancel.label}
          </button>
        </div>
      </div>
    </div>
  )
}
