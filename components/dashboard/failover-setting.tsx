"use client";

import { useEffect, useId, useState } from "react";

import { buttonStyles, cx } from "@/components/ui";
import {
  DEFAULT_FAILOVER,
  FAILOVER_OPTIONS,
  FAILOVER_URL,
  parseFailoverPolicy,
  type FailoverPolicy,
} from "@/lib/dashboard/failover";

type Status =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "unavailable" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

/**
 * Settings → "When an agent's included usage runs out" (§5). Never offers
 * paid usage or API keys: every option stays within included usage.
 */
export function FailoverSetting() {
  const [policy, setPolicy] = useState<FailoverPolicy>(DEFAULT_FAILOVER);
  const [saved, setSaved] = useState<FailoverPolicy | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const id = useId();

  useEffect(() => {
    let live = true;
    fetch(FAILOVER_URL, { cache: "no-store", headers: { accept: "application/json" } })
      .then(async (r) => {
        if (!live) return;
        const p = r.ok ? parseFailoverPolicy(await r.json().catch(() => null)) : null;
        if (!p) {
          setStatus(
            r.status === 404
              ? { kind: "unavailable" }
              : { kind: "error", message: "Could not load your preference." },
          );
          return;
        }
        setPolicy(p);
        setSaved(p);
        setStatus({ kind: "ready" });
      })
      .catch(
        () => live && setStatus({ kind: "error", message: "Could not load your preference." }),
      );
    return () => {
      live = false;
    };
  }, []);

  const save = async () => {
    setStatus({ kind: "saving" });
    try {
      const r = await fetch(FAILOVER_URL, {
        method: "PUT",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ policy }),
      });
      const p = r.ok ? parseFailoverPolicy(await r.json().catch(() => ({ policy }))) : null;
      if (!r.ok) throw new Error("save failed");
      setSaved(p ?? policy);
      setStatus({ kind: "saved" });
    } catch {
      setStatus({ kind: "error", message: "Could not save. Try again." });
    }
  };

  const disabled =
    status.kind === "loading" || status.kind === "unavailable" || status.kind === "saving";
  return (
    <section aria-labelledby={`${id}-h`} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id={`${id}-h`} className="text-base font-semibold tracking-tight">
          When an agent&apos;s included usage runs out
        </h2>
        <p className="text-muted text-sm">
          ThreadLink never buys credits or switches to API keys. It only uses what your plans
          already include.
        </p>
      </div>
      <fieldset className="grid gap-2 sm:grid-cols-3" disabled={disabled}>
        <legend className="sr-only">When an agent&apos;s included usage runs out</legend>
        {FAILOVER_OPTIONS.map((o) => (
          <label
            key={o.value}
            className={cx(
              "border-border has-[:checked]:border-accent has-[:checked]:bg-accent-soft flex cursor-pointer gap-3 rounded-xl border p-3 text-sm",
              disabled && "opacity-60",
            )}
          >
            <input
              type="radio"
              name={`${id}-policy`}
              value={o.value}
              checked={policy === o.value}
              onChange={() => {
                setPolicy(o.value);
                if (status.kind === "saved" || status.kind === "error")
                  setStatus({ kind: "ready" });
              }}
              className="mt-0.5"
            />
            <span>
              <span className="block font-medium">
                {o.label}
                {o.value === DEFAULT_FAILOVER ? (
                  <span className="text-subtle font-normal"> (default)</span>
                ) : null}
              </span>
              <span className="text-muted block text-xs">{o.description}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={disabled || policy === saved}
          className={cx(buttonStyles.secondary, "w-fit")}
        >
          {status.kind === "saving" ? "Saving…" : "Save"}
        </button>
        <p role="status" aria-live="polite" className="text-xs">
          {status.kind === "saved" ? (
            <span className="text-success">Saved.</span>
          ) : status.kind === "error" ? (
            <span className="text-danger">{status.message}</span>
          ) : status.kind === "unavailable" ? (
            <span className="text-muted">This setting is not available on this server yet.</span>
          ) : null}
        </p>
      </div>
    </section>
  );
}
