"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { revokeThreadLinkAction } from "@/app/dashboard/actions";
import { ActionStatus } from "@/components/dashboard/action-form";
import { buttonStyles } from "@/components/ui";
import { runAction, type ActionResult } from "@/lib/dashboard/action-result";

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={buttonStyles.danger}>
      {pending ? "Unlinking…" : label}
    </button>
  );
}

export function RevokeLinkButton({
  linkId,
  label = "Revoke link",
}: {
  linkId: string;
  label?: string;
}) {
  const [state, formAction] = useActionState<ActionResult | null, FormData>(
    (_previous, formData) => runAction(revokeThreadLinkAction, formData),
    null,
  );
  return (
    <form
      action={formAction}
      className="inline-flex flex-col items-start gap-1"
      onSubmit={(event) => {
        if (
          !window.confirm(
            "Unlink this conversation from Claude Code? Tasks will stop being delivered. History is kept.",
          )
        ) {
          event.preventDefault();
        }
      }}
    >
      <input type="hidden" name="linkId" value={linkId} />
      <SubmitButton label={label} />
      <ActionStatus state={state} />
    </form>
  );
}
