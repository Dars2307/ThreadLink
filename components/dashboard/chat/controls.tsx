"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import { controlJobAction } from "@/app/dashboard/chat-live-actions";
import { ActionStatus } from "@/components/dashboard/action-form";
import { COMPOSER_ID } from "@/components/dashboard/chat/composer";
import { buttonStyles, cx } from "@/components/ui";
import type { JobControl } from "@/lib/chat/types";
import { runAction, type ActionResult } from "@/lib/dashboard/action-result";
import { controlOptions, SEND_NOTE } from "@/lib/dashboard/timeline";

function Go({ label, danger }: { label: string; danger: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={
        danger
          ? cx(buttonStyles.danger, "px-3 py-1.5")
          : cx(buttonStyles.secondary, "px-3 py-1.5 text-xs")
      }
    >
      {pending ? "Sending…" : label}
    </button>
  );
}

/**
 * Job controls (§5): a note never stops anything; each control says exactly
 * what happens. "Stop now" asks again before it is sent.
 */
export function JobControls({
  chatId,
  job,
}: {
  chatId: string;
  job: { jobId: string; status: string; control: JobControl | null } | null;
}) {
  const [confirming, setConfirming] = useState<JobControl | null>(null);
  const [state, formAction] = useActionState<ActionResult | null, FormData>(
    (_prev, fd) => runAction(controlJobAction, fd),
    null,
  );
  if (!job) return null;
  const options = controlOptions(job);
  return (
    <details className="relative" id="tl-controls">
      <summary
        className={cx(buttonStyles.secondary, "cursor-pointer list-none px-3 py-1.5 text-xs")}
        aria-label="Job controls"
      >
        Controls ▾
      </summary>
      <div className="border-border bg-surface shadow-card absolute right-0 z-30 mt-1 flex w-[min(22rem,90vw)] flex-col gap-1 rounded-xl border p-2">
        <button
          type="button"
          onClick={() => document.getElementById(COMPOSER_ID)?.focus()}
          className="hover:bg-surface-muted flex flex-col items-start rounded-lg px-2 py-1.5 text-left"
        >
          <span className="text-sm font-medium">{SEND_NOTE.label}</span>
          <span className="text-muted text-xs">{SEND_NOTE.explain}</span>
        </button>
        <hr className="border-border" />
        {options.map((o) => (
          <form
            key={o.action}
            action={formAction}
            className="hover:bg-surface-muted flex flex-col gap-1 rounded-lg px-2 py-1.5"
          >
            <input type="hidden" name="jobId" value={job.jobId} />
            <input type="hidden" name="chatId" value={chatId} />
            <input type="hidden" name="action" value={o.action} />
            <span className="text-sm font-medium">{o.label}</span>
            <span className="text-muted text-xs">{o.explain}</span>
            {o.confirm ? (
              confirming === o.action ? (
                <span className="flex flex-wrap items-center gap-2 pt-1">
                  <input type="hidden" name="confirmed" value={o.action} />
                  <Go label={`Yes, ${o.label.toLowerCase()}`} danger />
                  <button
                    type="button"
                    className={buttonStyles.ghost}
                    onClick={() => setConfirming(null)}
                  >
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className={cx(buttonStyles.danger, "w-fit")}
                  onClick={() => setConfirming(o.action)}
                >
                  {o.label}…
                </button>
              )
            ) : (
              <span className="pt-1">
                <Go label={o.label} danger={false} />
              </span>
            )}
          </form>
        ))}
        <ActionStatus state={state} className="px-2" />
      </div>
    </details>
  );
}
