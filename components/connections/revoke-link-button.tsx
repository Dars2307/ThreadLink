"use client";

import { useFormStatus } from "react-dom";

import { revokeThreadLinkAction } from "@/app/dashboard/actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md border border-red-600/40 px-3 py-1 text-xs text-red-700 disabled:opacity-60 dark:text-red-400"
    >
      {pending ? "Revoking…" : "Revoke link"}
    </button>
  );
}

export function RevokeLinkButton({ linkId }: { linkId: string }) {
  return (
    <form
      action={revokeThreadLinkAction}
      onSubmit={(event) => {
        if (!window.confirm("Revoke this ThreadLink? It cannot be reactivated.")) {
          event.preventDefault();
        }
      }}
    >
      <input type="hidden" name="linkId" value={linkId} />
      <SubmitButton />
    </form>
  );
}
