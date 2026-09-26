/**
 * What an owner action tells the person who pressed the button.
 *
 * Messages are written for people and never carry database or provider error
 * text: the page re-renders with the true state either way, and a failure is
 * said out loud instead of silently reverting.
 */
export type ActionResult = {
  ok: boolean;
  message: string;
  /** Where the result can be seen (a dashboard path), e.g. a newly created chat. */
  href?: string;
};

/** Only a same-app dashboard path is ever linked from a result. */
export function safeHref(v: unknown): string | undefined {
  return typeof v === "string" &&
    /^\/dashboard(?:\/[A-Za-z0-9_\-/?=&%.]*)?$/.test(v) &&
    !v.includes("//")
    ? v
    : undefined;
}

export const saved = (message = "Saved"): ActionResult => ({ ok: true, message });
export const failed = (message: string): ActionResult => ({ ok: false, message });

/**
 * Runs an action and always ends with something to tell the person: a thrown
 * error (network drop, server restart) or a malformed reply becomes a plain
 * failure, never a blank or a raw error.
 */
export async function runAction(
  action: (formData: FormData) => Promise<ActionResult | void>,
  formData: FormData,
  doneMessage = "Saved",
): Promise<ActionResult> {
  try {
    const result = await action(formData);
    if (result === undefined) return saved(doneMessage);
    if (result && typeof result.ok === "boolean" && typeof result.message === "string") {
      const href = safeHref(result.href);
      return href
        ? { ok: result.ok, message: result.message, href }
        : { ok: result.ok, message: result.message };
    }
    return failed("Failed to save. Try again.");
  } catch {
    return failed("Failed to save. Check your connection and try again.");
  }
}
