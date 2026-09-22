import { requestPairingAction } from "@/app/dashboard/actions";
import { CopyField } from "@/components/copy-button";
import { Badge, buttonStyles, Card, cx } from "@/components/ui";
import type { SetupStep } from "@/lib/dashboard/view-model";
import type { OwnerSession } from "@/lib/sessions/queries";

const STATE_BADGE: Record<
  SetupStep["state"],
  { tone: "success" | "accent" | "warning" | "neutral"; label: string }
> = {
  done: { tone: "success", label: "Done" },
  current: { tone: "accent", label: "Next" },
  waiting: { tone: "warning", label: "Waiting for you" },
  optional: { tone: "neutral", label: "Optional" },
  todo: { tone: "neutral", label: "Later" },
};

/**
 * Guided setup. Everything a normal user needs is here; IDs are never shown.
 * Steps 2-4 mostly happen in the bridge's own `setup` wizard on the user's machine.
 */
export function SetupWizard({
  steps,
  origin,
  controllerSessions,
  agentSessions,
}: {
  steps: SetupStep[];
  origin: string;
  controllerSessions: OwnerSession[];
  agentSessions: OwnerSession[];
}) {
  const done = steps.filter((s) => s.state === "done").length;
  return (
    <Card labelledBy="setup-title">
      <div className="mb-5 flex flex-col gap-1">
        <h2 id="setup-title" className="text-base font-semibold tracking-tight">
          Set up ThreadLink
        </h2>
        <p className="text-muted text-sm">
          {done} of {steps.length} steps done. This takes about two minutes, once.
        </p>
      </div>
      <ol className="flex flex-col">
        {steps.map((step, index) => {
          const open = step.state === "current" || step.state === "waiting";
          return (
            <li key={step.key} className="relative flex gap-4 pb-6 last:pb-0">
              <div className="flex flex-col items-center">
                <span
                  aria-hidden
                  className={cx(
                    "flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                    step.state === "done"
                      ? "bg-success text-surface"
                      : open
                        ? "bg-accent text-accent-foreground"
                        : "border-border-strong text-subtle border",
                  )}
                >
                  {step.state === "done" ? "✓" : index + 1}
                </span>
                {index < steps.length - 1 ? (
                  <span aria-hidden className="bg-border mt-1 w-px flex-1" />
                ) : null}
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-3 pt-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className={cx("text-sm font-medium", step.state === "todo" && "text-subtle")}>
                    {step.title}
                  </h3>
                  <Badge tone={STATE_BADGE[step.state].tone}>{STATE_BADGE[step.state].label}</Badge>
                </div>
                {open || step.state === "optional" ? (
                  <StepBody
                    step={step}
                    origin={origin}
                    controllerSessions={controllerSessions}
                    agentSessions={agentSessions}
                  />
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

function StepBody({
  step,
  origin,
  controllerSessions,
  agentSessions,
}: {
  step: SetupStep;
  origin: string;
  controllerSessions: OwnerSession[];
  agentSessions: OwnerSession[];
}) {
  if (step.key === "chatgpt") {
    return (
      <div className="text-muted flex flex-col gap-3 text-sm">
        <p>
          In ChatGPT, open Settings → Apps &amp; Connectors, enable Developer mode, then create a
          connector with this URL and OAuth sign-in:
        </p>
        <CopyField label="ThreadLink MCP URL" value={`${origin}/mcp`} />
        <p>ChatGPT sends you here to sign in and approve. Nothing to copy back.</p>
      </div>
    );
  }
  if (step.key === "claude") {
    return (
      <div className="text-muted flex flex-col gap-3 text-sm">
        <p>
          On the computer where you use Claude Code, open a terminal in your project folder and run:
        </p>
        <CopyField label="Bridge setup command" value={`threadlink-bridge setup --url ${origin}`} />
        <p>
          It opens your browser to approve the connection, lets you pick your existing Claude
          session, and confirms the link - no IDs to copy.
          <span className="text-subtle block pt-1 text-xs">
            First time? From the ThreadLink repo run{" "}
            <code className="font-mono">npm link ./bridge</code> (or use{" "}
            <code className="font-mono">
              node bridge/src/cli.ts setup --workspace &lt;project&gt;
            </code>
            ).
          </span>
        </p>
      </div>
    );
  }
  if (step.key === "session") {
    return (
      <p className="text-muted text-sm">
        The bridge setup lists your Claude Code sessions for that folder so tasks continue the one
        you choose. Skip it and each task starts a fresh session. Change it later with{" "}
        <code className="font-mono">threadlink-bridge attach</code>.
      </p>
    );
  }
  if (step.state === "waiting") {
    return (
      <p className="text-muted text-sm">
        A link is waiting for approval on your computer. The bridge setup shows the request -
        confirm it there (or run <code className="font-mono">threadlink-bridge setup</code> again).
      </p>
    );
  }
  return (
    <div className="text-muted flex flex-col gap-3 text-sm">
      <p>
        In your ChatGPT conversation, say{" "}
        <span className="text-foreground font-medium">
          &ldquo;Link this chat to Claude Code&rdquo;
        </span>
        . Then confirm on your computer.
      </p>
      {controllerSessions.length && agentSessions.length ? (
        <form
          action={requestPairingAction}
          className="bg-surface-muted flex flex-col gap-3 rounded-xl p-3 sm:flex-row sm:items-end"
        >
          <label className="flex flex-1 flex-col gap-1">
            <span className="text-subtle text-xs">Or link from here: conversation</span>
            <select
              name="controllerSessionId"
              className="border-border-strong bg-surface text-foreground rounded-lg border px-3 py-2"
            >
              {controllerSessions.map((s) => (
                <option key={s.sessionId} value={s.sessionId}>
                  {s.displayName ??
                    `Conversation from ${new Date(s.createdAt).toLocaleDateString("en-GB")}`}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-1 flex-col gap-1">
            <span className="text-subtle text-xs">Claude Code session</span>
            <select
              name="agentSessionId"
              className="border-border-strong bg-surface text-foreground rounded-lg border px-3 py-2"
            >
              {agentSessions.map((s) => (
                <option key={s.sessionId} value={s.sessionId}>
                  {(s.displayName ?? "Claude Code").replace(/^Claude Code · /, "")}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className={buttonStyles.primary}>
            Link
          </button>
        </form>
      ) : null}
    </div>
  );
}
