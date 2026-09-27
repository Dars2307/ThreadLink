"use client";

import { memo, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import { uploadAttachmentAction } from "@/app/dashboard/chat-live-actions";
import { buttonStyles, cx } from "@/components/ui";
import { checkAttachment } from "@/lib/dashboard/attachments";
import {
  artifactHref,
  CHAT_POST_URL,
  checkDraft,
  COMPOSER_MAX,
  isPostResult,
  SEND_FAILED,
  sendOutcome,
} from "@/lib/dashboard/chat";
import {
  filterMentions,
  mentionAtCaret,
  mentionOptions,
  type Registry,
} from "@/lib/dashboard/registry";
import { composerBanner } from "@/lib/dashboard/timeline";

/** The composer's textarea id: keyboard shortcuts focus it by id. */
export const COMPOSER_ID = "tl-composer";

function newKey(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  }
}

type Attached = { key: string; title: string; artifactId: string | null };

/**
 * The composer owns its draft. Typing re-renders only this component, never
 * the timeline. @mentions come from the registry's aliases; text attachments
 * (≤ 64 KB) upload as artifacts and show as chips.
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
  activeJob: { status: string } | null;
  modeSummary: string;
  archived: boolean;
  hasProject: boolean;
  onSent: () => void;
}) {
  const [draft, setDraft] = useState("");
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
  const banner = composerBanner(activeJob, draft, registry, modeSummary);
  const remaining = COMPOSER_MAX - draft.length;

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
    let result: { ok: boolean; message: string };
    try {
      // Only the chat and the text: the server routes it by the chat's mode and any leading @mention.
      const res = await fetch(CHAT_POST_URL, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ chatId, body: check.body, idempotencyKey: idempotencyKey.current }),
      });
      const json: unknown = await res.json().catch(() => null);
      result = isPostResult(json) ? sendOutcome(json) : { ok: false, message: SEND_FAILED };
    } catch {
      result = { ok: false, message: SEND_FAILED };
    }
    setOutcome(result);
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
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
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
      setOutcome({ ok: r.ok, message: r.message });
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
  return (
    <form onSubmit={send} className="flex flex-col gap-2" aria-labelledby={`${ids}-h`}>
      <h2 id={`${ids}-h`} className="sr-only">
        Send a message
      </h2>
      <p
        className={cx(
          "rounded-xl px-3 py-2 text-xs",
          banner.tone === "accent" ? "bg-accent-soft text-accent" : "bg-surface-muted text-muted",
        )}
      >
        {banner.text}
        {!hasProject && !activeJob ? (
          <> Choose a project for this chat so the agents know which folder to work in.</>
        ) : null}
      </p>

      {options.length ? (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Mention an agent">
          {options.map((o) => (
            <button
              key={o.label}
              type="button"
              disabled={archived}
              title={o.description}
              onClick={() => {
                const rest = draft.replace(/^\s*@[a-z][a-z0-9_-]*\s*/i, "");
                const value = `${o.insert}${rest}`.slice(0, COMPOSER_MAX);
                idempotencyKey.current = null;
                setDraft(value);
                requestAnimationFrame(() => {
                  const el = textarea.current;
                  if (!el) return;
                  el.focus();
                  el.setSelectionRange(value.length, value.length);
                });
              }}
              className="border-border text-muted hover:bg-surface-muted hover:text-foreground rounded-full border px-2.5 py-0.5 text-xs disabled:opacity-60"
            >
              {o.label}
            </button>
          ))}
        </div>
      ) : null}

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

      <div className="relative">
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
          rows={3}
          disabled={archived}
          role="combobox"
          aria-expanded={Boolean(menu && filtered.length)}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={menu && filtered.length ? `${listId}-${menu.index}` : undefined}
          aria-describedby={`${ids}-count ${ids}-outcome`}
          placeholder={
            archived
              ? "This chat is archived."
              : "Write a message… (@ to mention, Ctrl + Enter to send)"
          }
          className="border-border-strong bg-surface w-full rounded-xl border px-3 py-2 text-base disabled:opacity-60 sm:text-sm"
        />
        {menu && filtered.length ? (
          <ul
            id={listId}
            role="listbox"
            aria-label="Mention"
            className="border-border bg-surface shadow-card absolute bottom-full left-2 z-20 mb-1 flex w-64 flex-col rounded-xl border p-1"
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
                  "flex cursor-pointer flex-col rounded-lg px-2 py-1 text-sm",
                  i === menu.index && "bg-accent-soft",
                )}
              >
                <span className="font-medium">{o.label}</span>
                <span className="text-muted text-xs">{o.description}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
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
            className={cx(
              buttonStyles.ghost,
              "cursor-pointer",
              (archived || uploading) && "opacity-60",
            )}
          >
            {uploading ? "Attaching…" : "Attach text file"}
          </label>
          <span
            id={`${ids}-count`}
            className={cx("text-xs tabular-nums", remaining < 200 ? "text-warning" : "text-subtle")}
          >
            {remaining.toLocaleString("en-GB")} left
          </span>
        </div>
        <button
          type="submit"
          disabled={sending || archived || draft.trim() === ""}
          className={buttonStyles.primary}
        >
          {sending ? "Sending…" : activeJob ? "Send note" : "Send"}
        </button>
      </div>
      <p
        id={`${ids}-outcome`}
        role={outcome && !outcome.ok ? "alert" : "status"}
        aria-live="polite"
        className={cx(
          "text-sm",
          !outcome && "sr-only",
          outcome?.ok ? "text-success" : "text-danger",
        )}
      >
        {outcome?.message ?? ""}
      </p>
      {archived ? (
        <p className="text-muted text-xs">
          This chat is archived. Restore it from the chat list to send messages.
        </p>
      ) : null}
    </form>
  );
});
