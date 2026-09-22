"use client";

import { useFormStatus } from "react-dom";

import { revokeConnectionAction } from "@/app/dashboard/actions";
import { buttonStyles } from "@/components/ui";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={buttonStyles.danger}>
      {pending ? "Revoking…" : "Revoke"}
    </button>
  );
}

export function RevokeConnectionButton({ connectionId }: { connectionId: string }) {
  return (
    <form
      action={revokeConnectionAction}
      onSubmit={(event) => {
        if (!window.confirm("Revoke this connection? Its credential stops working immediately.")) {
          event.preventDefault();
        }
      }}
    >
      <input type="hidden" name="connectionId" value={connectionId} />
      <SubmitButton />
    </form>
  );
}
