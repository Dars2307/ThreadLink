"use client";

import { useId, useRef, type ReactNode } from "react";
import { useFormStatus } from "react-dom";

import { buttonStyles, cx } from "@/components/ui";

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
  action: (formData: FormData) => Promise<void>;
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
  return (
    <>
      <button
        type="button"
        className={
          triggerClassName ?? (tone === "danger" ? buttonStyles.danger : buttonStyles.secondary)
        }
        onClick={() => dialog.current?.showModal()}
      >
        {label}
      </button>
      <dialog
        ref={dialog}
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-body`}
        className="border-border bg-surface text-foreground shadow-card m-auto w-[min(30rem,calc(100vw-2rem))] rounded-2xl border p-0 backdrop:bg-black/50"
      >
        <form
          action={async (formData) => {
            await action(formData);
            dialog.current?.close();
          }}
          className="flex flex-col gap-4 p-5 sm:p-6"
        >
          {Object.entries(fields).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))}
          <h2 id={`${id}-title`} className="text-base font-semibold tracking-tight">
            {title}
          </h2>
          <div id={`${id}-body`} className="text-muted flex flex-col gap-2 text-sm">
            {children}
          </div>
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
    </>
  );
}
