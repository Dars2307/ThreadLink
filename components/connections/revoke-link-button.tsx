"use client";

import { useFormStatus } from "react-dom";

import { revokeThreadLinkAction } from "@/app/dashboard/actions";
import { buttonStyles } from "@/components/ui";

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
  return (
    <form
      action={revokeThreadLinkAction}
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
    </form>
  );
}
