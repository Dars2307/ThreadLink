"use client";

import { useFormStatus } from "react-dom";

import { revokeConnectionAction } from "@/app/dashboard/actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md border border-red-600/40 px-3 py-1 text-xs text-red-700 disabled:opacity-60 dark:text-red-400"
    >
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
