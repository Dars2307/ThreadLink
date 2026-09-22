"use client";

import { useActionState, useState } from "react";

import { registerConnectionAction, type RegisterConnectionState } from "@/app/dashboard/actions";

const PLATFORM_LABELS: Record<string, string> = {
  chatgpt: "ChatGPT (controller)",
  "claude-code": "Claude Code (agent)",
};

export function RegisterConnectionForm() {
  const [state, formAction, pending] = useActionState<RegisterConnectionState, FormData>(
    registerConnectionAction,
    { status: "idle" },
  );
  // Lets the user dismiss the one-time credential; it is then gone for good.
  const [dismissedToken, setDismissedToken] = useState<string | null>(null);
  const showCredential = state.status === "issued" && state.token !== dismissedToken;

  return (
    <div className="flex flex-col gap-4">
      {showCredential && state.status === "issued" ? (
        <div
          role="alert"
          className="border-warning/40 bg-warning-soft flex flex-col gap-3 rounded-lg border p-4"
        >
          <p className="text-sm font-semibold">
            Save this credential now. ThreadLink will not display it again.
          </p>
          <p className="text-muted text-sm">
            {state.displayName ?? PLATFORM_LABELS[state.platform] ?? state.platform} ·{" "}
            <span className="font-mono">{state.tokenPrefix}…</span>
          </p>
          <code className="border-border bg-surface rounded-lg border p-3 font-mono text-sm break-all select-all">
            {state.token}
          </code>
          <div className="flex gap-2">
            <button
              type="button"
              className="border-border-strong bg-surface rounded-lg border px-3 py-1.5 text-sm"
              onClick={() => void navigator.clipboard?.writeText(state.token)}
            >
              Copy
            </button>
            <button
              type="button"
              className="border-border-strong bg-surface rounded-lg border px-3 py-1.5 text-sm"
              onClick={() => setDismissedToken(state.token)}
            >
              I have saved it
            </button>
          </div>
        </div>
      ) : null}

      <form
        action={formAction}
        autoComplete="off"
        className="border-border flex flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-end"
      >
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">Platform</span>
          <select
            name="platform"
            required
            defaultValue="claude-code"
            className="border-border-strong bg-surface rounded-lg border px-3 py-2"
          >
            <option value="chatgpt">{PLATFORM_LABELS.chatgpt}</option>
            <option value="claude-code">{PLATFORM_LABELS["claude-code"]}</option>
          </select>
        </label>
        <label className="flex flex-1 flex-col gap-1 text-sm">
          <span className="text-muted">Display name (optional)</span>
          <input
            name="displayName"
            maxLength={100}
            placeholder="e.g. Work laptop"
            className="border-border-strong bg-surface rounded-lg border px-3 py-2"
          />
        </label>
        <button
          type="submit"
          disabled={pending}
          className="bg-accent text-accent-foreground hover:bg-accent-hover rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-60"
        >
          {pending ? "Creating…" : "Create connection"}
        </button>
      </form>

      {state.status === "error" ? <p className="text-danger text-sm">{state.message}</p> : null}
    </div>
  );
}
