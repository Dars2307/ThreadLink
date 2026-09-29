import { ChevronDown, Ellipsis } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import {
  archiveChatAction,
  createChatAction,
  createGroupAction,
  deleteChatAction,
  deleteGroupAction,
  pinChatAction,
  renameChatAction,
  renameGroupAction,
  retryJobAction,
  setChatGroupAction,
  setChatModeAction,
  setChatProjectAction,
} from "@/app/dashboard/chat-actions";
import { ActionForm, SubmitButton } from "@/components/dashboard/action-form";
import { ConfirmAction } from "@/components/dashboard/confirm-action";
import { Badge, buttonStyles, cx } from "@/components/ui";
import type { JobMode } from "@/lib/chat/types";
import {
  MODE_LABELS,
  type ChatHeaderView,
  type ChatRow,
  type ModeControlView,
  type RetryOption,
} from "@/lib/dashboard/chats";
import type { ParticipantLine } from "@/lib/dashboard/providers-display";

const field = "border-border-strong bg-surface rounded-lg border px-3 py-2 text-sm";
const menuItem = cx(buttonStyles.ghost, "w-full justify-start");

export function ModeBadge({ badge, mode }: { badge: string; mode: JobMode }) {
  return (
    <span
      title={MODE_LABELS[mode]}
      className={cx(
        "inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 text-[0.65rem] font-semibold tracking-wide",
        mode === "solo" ? "bg-surface-muted text-muted" : "bg-accent-soft text-accent",
      )}
    >
      {badge}
    </span>
  );
}

/** Participants with health, from display metadata only. */
export function Participants({ lines }: { lines: ParticipantLine[] }) {
  const agents = lines.filter((l) => l.kind === "agent");
  if (agents.length === 0) {
    return <p className="text-muted text-sm">No agents in this chat yet.</p>;
  }
  return (
    <ul className="flex flex-wrap gap-2" aria-label="Agents in this chat">
      {agents.map((a) => (
        <li key={a.key}>
          <Badge tone={a.health?.tone ?? "neutral"}>{a.health?.line ?? a.name}</Badge>
        </li>
      ))}
    </ul>
  );
}

/** A fixed-text instruction for a provider that needs the user. */
export function Callout({ text, children }: { text: string; children?: ReactNode }) {
  return (
    <div
      role="status"
      className="border-warning/40 bg-warning-soft text-warning flex flex-col gap-3 rounded-xl border px-4 py-3 text-sm"
    >
      <p className="break-words">{text}</p>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chat list
// ---------------------------------------------------------------------------

export type Choice = { key: string; name: string; id: string };

/** One chat in the list: name, participants, mode, preview, time, badges and a menu. */
export function ChatListRow({
  row,
  href,
  chatId,
  groupId,
  roomId,
  projects,
  groups,
}: {
  row: ChatRow;
  href: string;
  chatId: string;
  groupId: string | null;
  roomId: string | null;
  projects: Choice[];
  groups: Choice[];
}) {
  return (
    <li className="border-border flex items-start gap-3 border-b py-3 last:border-b-0">
      <Link href={href} className="group min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span
            className={cx(
              "min-w-0 truncate text-sm group-hover:underline",
              row.unread ? "font-semibold" : "font-medium",
            )}
          >
            {row.name}
          </span>
          <ModeBadge badge={row.modeBadge} mode={row.mode} />
          {row.needsAttention ? <Badge tone="warning">Needs you</Badge> : null}
          {row.unread ? (
            <span className="bg-accent size-2 shrink-0 rounded-full" aria-label="Unread" />
          ) : null}
          {row.working ? <Badge tone="accent">Working</Badge> : null}
          {row.pinned ? <span className="text-subtle text-xs">Pinned</span> : null}
        </div>
        <p className="text-muted truncate pt-0.5 text-xs">
          {row.participants}
          {row.project ? ` · ${row.project}` : ""}
          {row.group ? ` · ${row.group}` : ""}
        </p>
        <p className="text-subtle truncate pt-0.5 text-sm">{row.preview}</p>
      </Link>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <span className="text-subtle text-xs whitespace-nowrap">{row.when}</span>
        <ChatMenu
          row={row}
          chatId={chatId}
          groupId={groupId}
          roomId={roomId}
          projects={projects}
          groups={groups}
        />
      </div>
    </li>
  );
}

/** Row actions. Plain forms: each says Saved or why it failed. */
export function ChatMenu({
  row,
  chatId,
  groupId,
  roomId,
  projects,
  groups,
}: {
  row: Pick<ChatRow, "name" | "pinned" | "archived">;
  chatId: string;
  groupId: string | null;
  roomId: string | null;
  projects: Choice[];
  groups: Choice[];
}) {
  return (
    <details className="relative">
      <summary
        className="text-muted hover:bg-active hover:text-foreground flex size-[30px] cursor-pointer list-none items-center justify-center rounded-md"
        aria-label={`Actions for ${row.name}`}
      >
        <Ellipsis aria-hidden className="size-4" />
      </summary>
      <div className="border-border bg-card shadow-float absolute right-0 z-30 mt-1 flex w-72 flex-col gap-3 rounded-xl border p-3">
        <ActionForm action={renameChatAction} className="flex flex-col gap-1">
          <input type="hidden" name="chatId" value={chatId} />
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-subtle">Name</span>
            <input
              key={row.name}
              name="name"
              defaultValue={row.name}
              required
              maxLength={100}
              className={field}
            />
          </label>
          <SubmitButton className={cx(buttonStyles.secondary, "w-fit")}>Rename</SubmitButton>
        </ActionForm>

        <div className="flex flex-wrap gap-1">
          <ActionForm action={pinChatAction} className="flex flex-col">
            <input type="hidden" name="chatId" value={chatId} />
            <input type="hidden" name="pinned" value={row.pinned ? "false" : "true"} />
            <SubmitButton className={menuItem} pendingLabel="Working…">
              {row.pinned ? "Unpin" : "Pin"}
            </SubmitButton>
          </ActionForm>
          <ActionForm action={archiveChatAction} className="flex flex-col">
            <input type="hidden" name="chatId" value={chatId} />
            <input type="hidden" name="archived" value={row.archived ? "false" : "true"} />
            <SubmitButton className={menuItem} pendingLabel="Working…">
              {row.archived ? "Restore" : "Archive"}
            </SubmitButton>
          </ActionForm>
        </div>

        <ActionForm action={setChatProjectAction} className="flex flex-col gap-1">
          <input type="hidden" name="chatId" value={chatId} />
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-subtle">Project</span>
            <select key={roomId ?? ""} name="roomId" defaultValue={roomId ?? ""} className={field}>
              <option value="">No project</option>
              {projects.map((p) => (
                <option key={p.key} value={p.id}>
                  {p.name}
                </option>
              ))}
              {roomId && !projects.some((p) => p.id === roomId) ? (
                <option value={roomId}>Current project</option>
              ) : null}
            </select>
          </label>
          <SubmitButton className={cx(buttonStyles.secondary, "w-fit")}>
            {roomId ? "Move" : "Add to project"}
          </SubmitButton>
          <span className="text-subtle text-[0.7rem]">Changes where future work runs only.</span>
        </ActionForm>

        <ActionForm action={setChatGroupAction} className="flex flex-col gap-1">
          <input type="hidden" name="chatId" value={chatId} />
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-subtle">Group</span>
            <select
              key={groupId ?? ""}
              name="groupId"
              defaultValue={groupId ?? ""}
              className={field}
            >
              <option value="">No group</option>
              {groups.map((g) => (
                <option key={g.key} value={g.id}>
                  {g.name}
                </option>
              ))}
              {/* The chat's own group is always a choice, so saving never clears it by accident. */}
              {groupId && !groups.some((g) => g.id === groupId) ? (
                <option value={groupId}>Current group</option>
              ) : null}
            </select>
          </label>
          <SubmitButton className={cx(buttonStyles.secondary, "w-fit")}>Save group</SubmitButton>
        </ActionForm>

        <div className="border-border border-t pt-2">
          <ConfirmAction
            action={deleteChatAction}
            fields={{ chatId }}
            label="Delete from ThreadLink"
            title={`Delete “${row.name}” from ThreadLink?`}
            confirmLabel="Delete chat"
          >
            <p>The chat and its messages are removed from ThreadLink.</p>
            <p className="text-foreground font-medium">
              Your project&apos;s files, Claude Code and Codex history, and your controller&apos;s
              own chat are not touched.
            </p>
          </ConfirmAction>
        </div>
      </div>
    </details>
  );
}

/** New chat: name, optional project, mode. */
export function NewChatForm({
  projects,
  defaultProject,
  groups,
}: {
  projects: Choice[];
  /** Preselected project id (e.g. "New chat in Prism"). */
  defaultProject?: string | null;
  groups?: Choice[];
}) {
  return (
    <ActionForm action={createChatAction} className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-subtle text-xs">Name</span>
          <input
            name="name"
            required
            maxLength={100}
            placeholder="What's it about?"
            className={field}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-subtle text-xs">Project (optional)</span>
          <select name="roomId" defaultValue={defaultProject ?? ""} className={field}>
            <option value="">No project yet</option>
            {projects.map((p) => (
              <option key={p.key} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        {groups && groups.length ? (
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-subtle text-xs">Group (optional)</span>
            <select name="groupId" defaultValue="" className={field}>
              <option value="">No group</option>
              {groups.map((g) => (
                <option key={g.key} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-subtle mb-1 text-xs">Who works on it</legend>
        <div className="flex flex-wrap gap-2">
          {(["solo", "pair", "team"] as const).map((m) => (
            <label
              key={m}
              className="border-border has-[:checked]:border-accent has-[:checked]:bg-accent-soft flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm"
            >
              <input type="radio" name="mode" value={m} defaultChecked={m === "team"} />
              {MODE_LABELS[m]}
            </label>
          ))}
        </div>
      </fieldset>
      <SubmitButton className={cx(buttonStyles.primary, "w-fit")} pendingLabel="Creating…">
        Create chat
      </SubmitButton>
    </ActionForm>
  );
}

/** Create, rename and delete custom groups. */
export function GroupManager({ groups }: { groups: Choice[] }) {
  return (
    <div className="flex flex-col gap-3">
      {groups.length ? (
        <ul className="flex flex-col gap-2">
          {groups.map((g) => (
            <li key={g.key} className="flex flex-wrap items-start gap-2">
              <ActionForm action={renameGroupAction} className="flex flex-wrap items-start gap-2">
                <input type="hidden" name="groupId" value={g.id} />
                <label className="flex flex-col text-sm">
                  <span className="sr-only">Name of {g.name}</span>
                  <input
                    key={g.name}
                    name="name"
                    defaultValue={g.name}
                    required
                    maxLength={60}
                    className={field}
                  />
                </label>
                <SubmitButton>Rename</SubmitButton>
              </ActionForm>
              <ConfirmAction
                action={deleteGroupAction}
                fields={{ groupId: g.id }}
                label="Delete"
                title={`Delete the group “${g.name}”?`}
                confirmLabel="Delete group"
              >
                <p>Only the group goes. Its chats are kept, without a group.</p>
              </ConfirmAction>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted text-sm">No groups yet.</p>
      )}
      <ActionForm action={createGroupAction} className="flex flex-wrap items-start gap-2">
        <label className="flex flex-col text-sm">
          <span className="sr-only">New group name</span>
          <input name="name" required maxLength={60} placeholder="New group" className={field} />
        </label>
        <SubmitButton pendingLabel="Creating…">Create group</SubmitButton>
      </ActionForm>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One chat
// ---------------------------------------------------------------------------

/** "Chat name [TEAM]", project, participants with health, and fixed-text callouts. */
export function ChatHeader({
  header,
  projectHref,
}: {
  header: ChatHeaderView;
  projectHref: string | null;
}) {
  return (
    <header className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="min-w-0 text-2xl font-semibold tracking-tight break-words sm:text-3xl">
          {header.name}
        </h1>
        <span className="text-accent bg-accent-soft rounded-md px-2 py-0.5 text-xs font-semibold tracking-wide">
          {header.modeBadge}
        </span>
        {header.archived ? <Badge tone="neutral">Archived</Badge> : null}
      </div>
      <p className={cx("text-sm", header.project ? "text-muted" : "text-warning")}>
        {header.project && projectHref ? (
          <>
            Project:{" "}
            <Link href={projectHref} className="text-accent">
              {header.project}
            </Link>
          </>
        ) : (
          header.projectText
        )}
      </p>
      <Participants lines={header.participants} />
      {header.callouts.map((c) => (
        <Callout key={c.key} text={c.text} />
      ))}
    </header>
  );
}

/** Solo (choose provider) · Builder + Reviewer (choose or Auto) · Team (participants). */
export function ModeControl({
  chatId,
  control,
  compact = false,
}: {
  chatId: string;
  control: ModeControlView;
  /** 0.10 header: a "[TEAM ▾]" chip that opens the same form as a popover. */
  compact?: boolean;
}) {
  return (
    <details className={compact ? "relative" : "border-border bg-surface rounded-2xl border"}>
      {compact ? (
        <summary
          className="border-border bg-card text-muted hover:text-foreground flex h-5 cursor-pointer list-none items-center gap-[3px] rounded-[5px] border px-1.5 text-[10px] font-semibold tracking-[0.05em]"
          aria-label={`Mode: ${control.summary}. Change mode`}
          title={control.summary}
        >
          {control.badge}
          <ChevronDown aria-hidden className="size-[11px]" />
        </summary>
      ) : (
        <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
          <span>
            <span className="text-subtle">Mode: </span>
            <span className="font-medium">{control.summary}</span>
          </span>
          <span className="text-accent text-xs">Change</span>
        </summary>
      )}
      <ActionForm
        action={setChatModeAction}
        className={
          compact
            ? "border-border bg-card shadow-float absolute left-0 z-30 mt-1 flex w-[min(24rem,90vw)] flex-col gap-4 rounded-2xl border p-4"
            : "flex flex-col gap-4 px-4 pb-4"
        }
      >
        <input type="hidden" name="chatId" value={chatId} />
        {/* Keyed on the saved settings so a re-render shows the server's truth. */}
        <fieldset
          key={`${control.mode}|${control.solo}|${control.builder}|${control.reviewer}`}
          className="flex flex-col gap-3"
        >
          <legend className="sr-only">Mode</legend>
          {control.options.map((o) => (
            <div key={o.value} className="flex flex-col gap-2">
              <label
                className={cx(
                  "border-border has-[:checked]:border-accent has-[:checked]:bg-accent-soft flex cursor-pointer gap-3 rounded-xl border p-3 text-sm",
                  !o.available && "opacity-60",
                )}
              >
                <input
                  type="radio"
                  name="mode"
                  value={o.value}
                  defaultChecked={control.mode === o.value}
                  disabled={!o.available}
                  className="mt-0.5"
                />
                <span>
                  <span className="block font-medium">{o.label}</span>
                  <span className="text-muted block text-xs">
                    {o.value === "team" ? `${o.description} (${control.team})` : o.description}
                    {o.available ? "" : " Needs more agents in this chat."}
                  </span>
                </span>
              </label>
              {o.value === "solo" ? (
                <label className="flex items-center gap-2 pl-8 text-sm">
                  <span className="text-muted">Agent</span>
                  <select name="soloProvider" defaultValue={control.solo} className={field}>
                    {control.providers.map((p) => (
                      <option key={p.value} value={p.value}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {o.value === "pair" ? (
                <div className="flex flex-wrap gap-3 pl-8 text-sm">
                  <label className="flex items-center gap-2">
                    <span className="text-muted">Builder</span>
                    <select name="builderProvider" defaultValue={control.builder} className={field}>
                      {control.providers.map((p) => (
                        <option key={p.value} value={p.value}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex items-center gap-2">
                    <span className="text-muted">Reviewer</span>
                    <select
                      name="reviewerProvider"
                      defaultValue={control.reviewer}
                      className={field}
                    >
                      {control.providers.map((p) => (
                        <option key={p.value} value={p.value}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              ) : null}
            </div>
          ))}
        </fieldset>
        <p className="text-subtle text-xs">{control.note}</p>
        <SubmitButton className={cx(buttonStyles.primary, "w-fit")}>Save mode</SubmitButton>
      </ActionForm>
    </details>
  );
}

/** A blocked job's callout, with the explicit retry when it is allowed. */
export function BlockedJob({
  text,
  retry,
  jobId,
}: {
  text: string;
  retry: RetryOption | null;
  jobId: string;
}) {
  return (
    <Callout text={text}>
      {retry ? (
        <div>
          <ConfirmAction
            action={retryJobAction}
            fields={{ jobId, coordinator: retry.provider, confirmed: "retry" }}
            label={retry.label}
            title={`${retry.label}?`}
            confirmLabel={retry.label}
            tone="primary"
          >
            <p>{retry.confirm}</p>
          </ConfirmAction>
        </div>
      ) : null}
    </Callout>
  );
}
