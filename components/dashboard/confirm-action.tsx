"use client";

import { useActionState, useId, useRef, type ReactNode } from "react";
import { useFormStatus } from "react-dom";

import { ActionStatus } from "@/components/dashboard/action-form";
import { buttonStyles, cx } from "@/components/ui";
import { runAction, type ActionResult } from "@/lib/dashboard/action-result";

function Submit({ label, tone }: { label: string; tone: "danger" | "primary" }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={cx(
        tone === "danger"
          ? "bg-danger text-surface inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-medium transition-opacity hover:opacity-90 disabled:opacity-60"
          : buttonStyles.primary,
      )}
    >
      {pending ? "Working…" : label}
    </button>
  );
}

/**
 * A button that opens a confirmation dialog; the action runs only from the
 * dialog's confirm button. `fields` become hidden inputs (identifiers stay out
 * of the visible page).
 *
 * On failure the dialog stays open and says why in plain words; on success it
 * closes and the outcome is announced next to the button. Nothing is silent.
 */
export function ConfirmAction({
  action,
  fields,
  label,
  title,
  children,
  confirmLabel,
  tone = "danger",
  triggerClassName,
}: {
  action: (formData: FormData) => Promise<ActionResult | void>;
  fields: Record<string, string>;
  label: string;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  tone?: "danger" | "primary";
  triggerClassName?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  const [state, formAction] = useActionState<ActionResult | null, FormData>(
    async (_previous, formData) => {
      const result = await runAction(action, formData, "Done.");
      if (result.ok) dialog.current?.close();
      return result;
    },
    null,
  );
  const inDialog = state && !state.ok ? state : null;
  const outside = state && state.ok ? state : null;

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        className={
          triggerClassName ?? (tone === "danger" ? buttonStyles.danger : buttonStyles.secondary)
        }
        onClick={() => dialog.current?.showModal()}
      >
        {label}
      </button>
      <ActionStatus state={outside} />
      <dialog
        ref={dialog}
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-body`}
        className="border-border bg-surface text-foreground shadow-card m-auto w-[min(30rem,calc(100vw-2rem))] rounded-2xl border p-0 backdrop:bg-black/50"
      >
        <form action={formAction} className="flex flex-col gap-4 p-5 sm:p-6">
          {Object.entries(fields).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))}
          <h2 id={`${id}-title`} className="text-base font-semibold tracking-tight">
            {title}
          </h2>
          <div id={`${id}-body`} className="text-muted flex flex-col gap-2 text-sm">
            {children}
          </div>
          <ActionStatus state={inDialog} className="text-sm" />
          <div className="flex flex-wrap justify-end gap-2 pt-1">
            <button
              type="button"
              className={buttonStyles.secondary}
              onClick={() => dialog.current?.close()}
            >
              Cancel
            </button>
            <Submit label={confirmLabel} tone={tone} />
          </div>
        </form>
      </dialog>
    </span>
  );
}
