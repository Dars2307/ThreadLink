"use client";

import { useActionState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";

import { buttonStyles, cx } from "@/components/ui";
import { runAction, type ActionResult } from "@/lib/dashboard/action-result";

/**
 * A form for an owner action that reports what happened: "Saved" or a plain
 * reason it failed. Nothing is swallowed silently.
 *
 * React resets a form after its action runs, and a mounted select or radio
 * keeps the value it was first rendered with. Give such inputs a `key` of the
 * saved value so they re-mount with the server's truth.
 */
export function ActionForm({
  action,
  children,
  className,
  statusClassName,
}: {
  action: (formData: FormData) => Promise<ActionResult>;
  children: ReactNode;
  className?: string;
  statusClassName?: string;
}) {
  const [state, formAction] = useActionState<ActionResult | null, FormData>(
    (_previous, formData) => runAction(action, formData),
    null,
  );
  return (
    <form action={formAction} className={className}>
      {children}
      <ActionStatus state={state} className={statusClassName} />
    </form>
  );
}

export function ActionStatus({
  state,
  className,
}: {
  state: ActionResult | null;
  className?: string;
}) {
  return (
    <p
      role={state && !state.ok ? "alert" : "status"}
      aria-live="polite"
      className={cx(
        "text-xs",
        !state && "sr-only",
        state?.ok ? "text-success" : "text-danger",
        className,
      )}
    >
      {state ? state.message : ""}
    </p>
  );
}

/** A submit button that says it is working while the action runs. */
export function SubmitButton({
  children,
  className = buttonStyles.secondary,
  name,
  value,
  pendingLabel = "Saving…",
}: {
  children: ReactNode;
  className?: string;
  name?: string;
  value?: string;
  pendingLabel?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={className} name={name} value={value}>
      {pending ? pendingLabel : children}
    </button>
  );
}
