/**
 * Masks an identifier for display, keeping its type prefix and a short tail
 * (e.g. `user_2abcDEF...` -> `user_…EF12`). For UI/debugging only; masked
 * values must never be used for lookups or authorization.
 */
export function maskIdentifier(id: string, visibleTail = 4): string {
  const separator = id.indexOf("_");
  const prefix = separator > 0 ? id.slice(0, separator + 1) : "";
  const body = id.slice(prefix.length);
  if (body.length <= visibleTail * 2) return `${prefix}…`;
  return `${prefix}…${body.slice(-visibleTail)}`;
}
