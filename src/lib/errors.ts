/**
 * Extract a readable message from an unknown thrown value.
 *
 * Previously copy-pasted (`e instanceof Error ? e.message : '…'`) in a dozen
 * catch blocks across the pages and hooks.
 */
export function errText(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback
}
