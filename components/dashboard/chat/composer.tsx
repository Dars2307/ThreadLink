"use client";

import { ArrowUp, AtSign, ChevronDown, Plus, Sparkles } from "lucide-react";
import {
  memo,
  useActionState,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { useFormStatus } from "react-dom";

import { controlJobAction, uploadAttachmentAction } from "@/app/dashboard/chat-live-actions";
import { ActionStatus } from "@/components/dashboard/action-form";
import { buttonStyles, cx } from "@/components/ui";
import type { JobControl } from "@/lib/chat/types";
import { runAction, type ActionResult } from "@/lib/dashboard/action-result";
import { checkAttachment } from "@/lib/dashboard/attachments";
import {
  artifactHref,
  CHAT_POST_URL,
  checkDraft,
  COMPOSER_MAX,
  composerKey,
  isPostResult,
  LANES,
  parseLane,
  SEND_FAILED,
  sendOutcome,
  type Lane,
} from "@/lib/dashboard/chat";
import {
  filterMentions,
  mentionAtCaret,
  mentionOptions,
  type Registry,
} from "@/lib/dashboard/registry";
import { controlOptions } from "@/lib/dashboard/timeline";
import { agentShortName } from "@/runtime/src/chat-presentation";

/** The composer's textarea id: keyboard shortcuts focus it by id. */
export const COMPOSER_ID = "tl-composer";
/** The textarea grows with its text up to this many pixels, then scrolls. */
const MAX_HEIGHT_PX = 240;

function newKey(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  }
}

type Attached = { key: string; title: string; artifactId: string | null };

export type ComposerJob = {
  jobId: string;
  status: string;
  control: JobControl | null;
} | null;

function StopSubmit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={cx(buttonStyles.danger, "px-3 py-1.5")}>
      {pending ? "Stopping…" : label}
    </button>
  );
}

/** Stop while work is active: asks once, then sends the existing stop control. */
function StopControl({ chatId, job }: { chatId: string; job: NonNullable<ComposerJob> }) {
  const [asking, setAsking] = useState(false);
  const [state, formAction] = useActionState<ActionResult | null, FormData>(
    (_prev, fd) => runAction(controlJobAction, fd),
    null,
  );
  const options = controlOptions(job);
  const stop =
    options.find((o) => o.action === "stop_now") ??
    options.find((o) => o.action === "cancel_queued") ??
    null;
  if (!stop) return null;
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setAsking((v) => !v)}
        aria-expanded={asking}
        className="border-field text-foreground hover:bg-active flex h-9 items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium sm:h-[34px] sm:rounded-[10px]"
      >
        <span aria-hidden className="bg-foreground size-[9px] rounded-[2px]" />
        Stop work
      </button>
      {asking ? (
        <form
          action={formAction}
          className="tl-glass border-field shadow-float absolute right-0 bottom-full z-30 mb-2 flex w-72 flex-col gap-2 rounded-xl border p-3 text-sm"
        >
          <input type="hidden" name="jobId" value={job.jobId} />
          <input type="hidden" name="chatId" value={chatId} />
          <input type="hidden" name="action" value={stop.action} />
          <input type="hidden" name="confirmed" value={stop.action} />
          <p className="font-medium">{stop.label}?</p>
          <p className="text-muted text-xs">{stop.explain}</p>
          <div className="flex gap-2">
            <StopSubmit label={stop.label} />
            <button type="button" className={buttonStyles.ghost} onClick={() => setAsking(false)}>
              Keep going
            </button>
          </div>
          <ActionStatus state={state} />
        </form>
      ) : null}
    </div>
  );
}

/**
 * The composer owns its draft: typing re-renders only this component, never
 * the timeline. Enter sends, Shift+Enter is a new line (touch keyboards: the
 * Send button sends). @mentions autocomplete from the registry; a quiet
 * "Auto ▾" control sends `lane`; Stop appears while work is active.
 */
export const Composer = memo(function Composer({
  chatId,
  registry,
  agentIds,
  activeJob,
  modeSummary,
  archived,
  hasProject,
  onSent,
}: {
  chatId: string;
  registry: Registry;
  agentIds: string[];
  activeJob: ComposerJob;
  modeSummary: string;
  archived: boolean;
  hasProject: boolean;
  onSent: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [lane, setLane] = useState<Lane>("auto");
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; message: string } | null>(null);
  const [menu, setMenu] = useState<{ start: number; typed: string; index: number } | null>(null);
  const [attached, setAttached] = useState<Attached[]>([]);
  const [uploading, setUploading] = useState(false);
  const idempotencyKey = useRef<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const ids = useId();

  const options = useMemo(() => mentionOptions(registry, agentIds), [registry, agentIds]);
  const filtered = menu ? filterMentions(options, menu.typed) : [];
  const remaining = COMPOSER_MAX - draft.length;
  const laneHint = LANES.find((l) => l.value === lane)!.hint;

  // Autosize: one measurement per change, capped; no layout work while idle.
  useLayoutEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
    el.style.overflowY = el.scrollHeight > MAX_HEIGHT_PX ? "auto" : "hidden";
  }, [draft]);

  const change = (value: string, caret: number) => {
    idempotencyKey.current = null; // a changed message is a new message
    setDraft(value);
    if (outcome && !outcome.ok) setOutcome(null);
    const at = mentionAtCaret(value, caret);
    setMenu(at ? { ...at, index: 0 } : null);
  };

  const insertMention = (insert: string) => {
    const el = textarea.current;
    const start = menu?.start ?? 0;
    const end = el?.selectionStart ?? draft.length;
    const value = (draft.slice(0, start) + insert + draft.slice(end)).slice(0, COMPOSER_MAX);
    setDraft(value);
    setMenu(null);
    idempotencyKey.current = null;
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      const pos = Math.min(value.length, start + insert.length);
      el.setSelectionRange(pos, pos);
    });
  };

  const startMention = () => {
    const el = textarea.current;
    const at = el?.selectionStart ?? draft.length;
    const before = draft.slice(0, at);
    const insert = before === "" || /\s$/.test(before) ? "@" : " @";
    const value = (before + insert + draft.slice(at)).slice(0, COMPOSER_MAX);
    const caret = Math.min(value.length, at + insert.length);
    change(value, caret);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };

  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    if (sending || archived) return;
    const check = checkDraft(draft);
    if (!check.ok) {
      setOutcome({ ok: false, message: check.message });
      textarea.current?.focus();
      return;
    }
    idempotencyKey.current ??= newKey();
    setSending(true);
    setOutcome(null);
    let result: { ok: boolean; message: string; quiet: boolean };
    try {
      // The chat, the text and the execution preference: the server routes it.
      const res = await fetch(CHAT_POST_URL, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          chatId,
          body: check.body,
          idempotencyKey: idempotencyKey.current,
          lane: parseLane(lane),
        }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (isPostResult(json)) {
        const o = sendOutcome(json);
        // A plain send speaks for itself in the timeline; only notable outcomes are said.
        const notable =
          !json.ok || json.routed === "choice_resolved" || json.routed === "stop_requested";
        result = { ...o, quiet: !notable };
      } else {
        result = { ok: false, message: SEND_FAILED, quiet: false };
      }
    } catch {
      result = { ok: false, message: SEND_FAILED, quiet: false };
    }
    setOutcome(result.quiet ? null : { ok: result.ok, message: result.message });
    setSending(false);
    if (result.ok) {
      idempotencyKey.current = null;
      setDraft("");
      setAttached([]);
      onSent();
    }
    requestAnimationFrame(() => textarea.current?.focus());
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (menu && filtered.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const d = e.key === "ArrowDown" ? 1 : -1;
        setMenu({ ...menu, index: (menu.index + d + filtered.length) % filtered.length });
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        insertMention(filtered[menu.index]!.insert);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setMenu(null);
        return;
      }
    }
    const action = composerKey({
      key: e.key,
      shiftKey: e.shiftKey,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      altKey: e.altKey,
      isComposing: e.nativeEvent.isComposing,
      coarsePointer:
        typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches === true,
    });
    if (action === "send") {
      e.preventDefault();
      void send();
    } else if (e.key === "Escape" && draft) {
      e.stopPropagation();
      textarea.current?.blur();
    }
  };

  const upload = async (file: File) => {
    const check = checkAttachment({ name: file.name, size: file.size, type: file.type });
    if (!check.ok) {
      setOutcome({ ok: false, message: check.message });
      return;
    }
    setUploading(true);
    const fd = new FormData();
    fd.set("chatId", chatId);
    fd.set("file", file);
    try {
      const r = await uploadAttachmentAction(fd);
      setOutcome(r.ok ? null : { ok: false, message: r.message });
      if (r.ok) {
        setAttached((a) => [
          ...a,
          { key: newKey(), title: r.title ?? check.title, artifactId: r.artifactId ?? null },
        ]);
        // Mentioning the file is what shares it with the agents.
        setDraft((d) =>
          (d.includes(check.title)
            ? d
            : `${d}${d && !d.endsWith(" ") ? " " : ""}[${check.title}] `
          ).slice(0, COMPOSER_MAX),
        );
      }
    } catch {
      setOutcome({ ok: false, message: "Could not attach the file." });
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const listId = `${ids}-mentions`;
  const names = options
    .filter((o) => o.providerId)
    .map((o) => agentShortName(o.providerId, registry.byId.get(o.providerId!)?.shortName));
  const placeholder = archived
    ? "This chat is archived."
    : names.length
      ? `Message ${names.join(" and ")}… (@ to mention)`
      : "Write a message… (@ to mention)";

  return (
    <form onSubmit={send} className="flex flex-col gap-1.5" aria-labelledby={`${ids}-h`}>
      <h2 id={`${ids}-h`} className="sr-only">
        Send a message
      </h2>

      {attached.length ? (
        <ul className="flex flex-wrap gap-1.5" aria-label="Attached files">
          {attached.map((a) => (
            <li
              key={a.key}
              className="border-border bg-surface-muted flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs"
            >
              <span aria-hidden>📎</span>
              {a.artifactId ? (
                <a
                  href={artifactHref(chatId, a.artifactId)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:underline"
                >
                  {a.title}
                </a>
              ) : (
                a.title
              )}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="tl-composer-beam shadow-float">
      <div className="tl-glass border-field relative flex flex-col gap-2.5 rounded-[22px] border py-2 pr-2 pl-3.5 sm:rounded-2xl sm:pt-3 sm:pr-3 sm:pb-2.5 sm:pl-4">
        <label htmlFor={COMPOSER_ID} className="sr-only">
          Message
        </label>
        <textarea
          id={COMPOSER_ID}
          ref={textarea}
          value={draft}
          onChange={(e) => change(e.target.value, e.target.selectionStart)}
          onKeyDown={onKeyDown}
          onBlur={() => setTimeout(() => setMenu(null), 150)}
          maxLength={COMPOSER_MAX}
          rows={1}
          disabled={archived}
          role="combobox"
          aria-expanded={Boolean(menu && filtered.length)}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={menu && filtered.length ? `${listId}-${menu.index}` : undefined}
          aria-describedby={`${ids}-hint ${ids}-outcome`}
          placeholder={placeholder}
          className="text-foreground placeholder:text-subtle max-h-60 min-h-7 w-full resize-none bg-transparent py-0.5 text-base leading-normal outline-none disabled:opacity-60 sm:text-[15px]"
        />
        {menu && filtered.length ? (
          <ul
            id={listId}
            role="listbox"
            aria-label="Mention"
            className="tl-glass border-field shadow-float absolute bottom-full left-2 z-20 mb-2 flex w-64 flex-col rounded-xl border p-1"
          >
            {filtered.map((o, i) => (
              <li
                key={o.label}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === menu.index}
                onMouseDown={(e) => {
                  e.preventDefault();
                  insertMention(o.insert);
                }}
                className={cx(
                  "flex cursor-pointer items-baseline justify-between gap-2 rounded-lg px-2 py-1.5 text-sm",
                  i === menu.index && "bg-active",
                )}
              >
                <span className="font-medium">
                  {o.providerId
                    ? agentShortName(o.providerId, registry.byId.get(o.providerId)?.shortName)
                    : "Team"}
                </span>
                <span className="text-subtle text-xs">{o.label}</span>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1">
            <input
              ref={fileInput}
              type="file"
              accept=".txt,.md,.log,.json,.yaml,.yml,.toml,.csv,.diff,.patch,.ts,.tsx,.js,.py,.sql,text/*"
              className="sr-only"
              id={`${ids}-file`}
              disabled={archived || uploading}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void upload(f);
              }}
            />
            <label
              htmlFor={`${ids}-file`}
              title="Attach a text file"
              className={cx(
                "text-subtle hover:bg-active hover:text-foreground flex size-[30px] cursor-pointer items-center justify-center rounded-lg",
                (archived || uploading) && "opacity-60",
              )}
            >
              <Plus aria-hidden className="size-4" />
              <span className="sr-only">{uploading ? "Attaching…" : "Attach text file"}</span>
            </label>
            <button
              type="button"
              aria-label="Mention an agent"
              disabled={archived}
              onClick={startMention}
              className="text-subtle hover:bg-active hover:text-foreground flex size-[30px] items-center justify-center rounded-lg"
            >
              <AtSign aria-hidden className="size-4" />
            </button>
            <label className="sr-only" htmlFor={`${ids}-lane`}>
              How to run it
            </label>
            <span className="text-muted hover:text-foreground relative flex items-center">
              <Sparkles aria-hidden className="pointer-events-none absolute left-2 size-[13px]" />
              <select
                id={`${ids}-lane`}
                value={lane}
                onChange={(e) => setLane(parseLane(e.target.value))}
                disabled={archived}
                title={laneHint}
                className="bg-chip h-7 cursor-pointer appearance-none rounded-[7px] pr-6 pl-[26px] text-xs font-medium"
              >
                {LANES.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label}
                  </option>
                ))}
              </select>
              <ChevronDown aria-hidden className="pointer-events-none absolute right-1.5 size-3" />
            </span>
            {remaining < 500 ? (
              <span
                className={cx(
                  "text-xs tabular-nums",
                  remaining < 200 ? "text-warning" : "text-subtle",
                )}
              >
                {remaining.toLocaleString("en-GB")} left
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            {activeJob ? <StopControl chatId={chatId} job={activeJob} /> : null}
            <button
              type="submit"
              aria-label={sending ? "Sending…" : "Send"}
              disabled={sending || archived || draft.trim() === ""}
              className="bg-send-bg text-send-fg flex size-9 items-center justify-center rounded-full transition-opacity hover:opacity-90 disabled:opacity-35 motion-reduce:transition-none sm:size-[34px] sm:rounded-[10px]"
            >
              <ArrowUp aria-hidden className="size-4" strokeWidth={2.2} />
            </button>
          </div>
        </div>
      </div>
      </div>
      <p className="text-subtle hidden text-center text-[11px] sm:block">
        {lane === "auto"
          ? "Auto chats until you ask for repository work · Enter to send"
          : lane === "chat"
            ? "Chat only: nothing in the project changes · Enter to send"
            : "Runs as work in the project · Enter to send"}
      </p>
      <p id={`${ids}-hint`} className="sr-only">
        {`Enter sends, Shift+Enter adds a line. ${laneHint} Mode: ${modeSummary}.`}
        {!hasProject
          ? " Choose a project for this chat so the agents know which folder to work in."
          : ""}
      </p>
      {!hasProject && !archived ? (
        <p className="text-subtle px-1 text-xs">
          Choose a project for this chat so the agents know which folder to work in.
        </p>
      ) : null}
      <p
        id={`${ids}-outcome`}
        role={outcome && !outcome.ok ? "alert" : "status"}
        aria-live="polite"
        className={cx(
          "px-1 text-xs",
          !outcome && "sr-only",
          outcome?.ok ? "text-muted" : "text-danger",
        )}
      >
        {outcome?.message ?? ""}
      </p>
      {archived ? (
        <p className="text-muted px-1 text-xs">
          This chat is archived. Restore it from the chat list to send messages.
        </p>
      ) : null}
    </form>
  );
});
