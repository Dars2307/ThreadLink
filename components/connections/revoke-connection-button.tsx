"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { revokeConnectionAction } from "@/app/dashboard/actions";
import { ActionStatus } from "@/components/dashboard/action-form";
import { buttonStyles } from "@/components/ui";
import { runAction, type ActionResult } from "@/lib/dashboard/action-result";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={buttonStyles.danger}>
      {pending ? "Revoking…" : "Revoke"}
    </button>
  );
}

export function RevokeConnectionButton({ connectionId }: { connectionId: string }) {
  const [state, formAction] = useActionState<ActionResult | null, FormData>(
    (_previous, formData) => runAction(revokeConnectionAction, formData),
    null,
  );
  return (
    <form
      action={formAction}
      className="inline-flex flex-col items-end gap-1"
      onSubmit={(event) => {
        if (!window.confirm("Revoke this connection? Its credential stops working immediately.")) {
          event.preventDefault();
        }
      }}
    >
      <input type="hidden" name="connectionId" value={connectionId} />
      <SubmitButton />
      <ActionStatus state={state} />
    </form>
  );
}
