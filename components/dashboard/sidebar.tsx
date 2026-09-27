"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";

import { cx } from "@/components/ui";
import type { ChatNav, NavChat, NavFolder } from "@/lib/dashboard/nav";

/** Primary navigation (docs/design/chat-first.md §7). Devices live under Agents and Settings. */
export const NAV = [
  { href: "/dashboard", label: "Home" },
  { href: "/dashboard/chats", label: "Chats" },
  { href: "/dashboard/projects", label: "Projects" },
  { href: "/dashboard/agents", label: "Agents" },
  { href: "/dashboard/notifications", label: "Notifications" },
  { href: "/dashboard/settings", label: "Settings" },
] as const;

/** The sidebar search box id: Ctrl+K focuses it. */
export const SEARCH_ID = "tl-search";

/** Home matches exactly; every other section also owns its sub-pages. */
function isActive(pathname: string, href: string): boolean {
  if (href === "/dashboard") return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

function ChatLink({
  chat,
  pathname,
  onNavigate,
}: {
  chat: NavChat;
  pathname: string;
  onNavigate: () => void;
}) {
  const active = pathname === chat.href;
  return (
    <Link
      href={chat.href}
      aria-current={active ? "page" : undefined}
      onClick={onNavigate}
      className={cx(
        "flex min-w-0 items-center gap-2 rounded-lg px-3 py-1.5 text-sm transition-colors",
        active
          ? "bg-accent-soft text-accent font-medium"
          : "text-muted hover:bg-surface-muted hover:text-foreground",
      )}
    >
      <span
        className={cx("min-w-0 flex-1 truncate", chat.unread && "text-foreground font-semibold")}
      >
        {chat.name}
      </span>
      {chat.needsAttention ? (
        <span className="text-warning shrink-0 text-[0.65rem] font-semibold">Needs you</span>
      ) : chat.working ? (
        <span className="text-accent shrink-0 text-[0.65rem]">Working</span>
      ) : chat.unread ? (
        <span className="text-accent shrink-0 text-[0.65rem]">New</span>
      ) : null}
    </Link>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details open className="group">
      <summary className="text-subtle hover:text-foreground cursor-pointer list-none px-3 pt-3 pb-1 text-[0.7rem] font-semibold tracking-wide uppercase">
        {title}
        <span aria-hidden className="pl-1 group-open:hidden">
          ▸
        </span>
      </summary>
      <div className="flex flex-col gap-0.5">{children}</div>
    </details>
  );
}

function Folder({
  folder,
  pathname,
  onNavigate,
}: {
  folder: NavFolder;
  pathname: string;
  onNavigate: () => void;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      {folder.href ? (
        <Link
          href={folder.href}
          onClick={onNavigate}
          className="text-foreground hover:bg-surface-muted truncate rounded-lg px-3 py-1 text-xs font-medium"
        >
          {folder.name}
        </Link>
      ) : (
        <span className="px-3 py-1 text-xs font-medium">{folder.name}</span>
      )}
      <div className="border-border ml-3 flex flex-col gap-0.5 border-l pl-1">
        {folder.chats.map((c) => (
          <ChatLink key={c.key} chat={c} pathname={pathname} onNavigate={onNavigate} />
        ))}
        {folder.more > 0 && folder.href ? (
          <Link href={folder.href} onClick={onNavigate} className="text-subtle px-3 py-1 text-xs">
            {folder.more} more…
          </Link>
        ) : null}
      </div>
    </div>
  );
}

function ChatSections({
  nav,
  pathname,
  onNavigate,
}: {
  nav: ChatNav;
  pathname: string;
  onNavigate: () => void;
}) {
  if (nav.total === 0) return null;
  return (
    <nav aria-label="Chats" className="flex flex-col">
      {nav.pinned.length ? (
        <Section title="Pinned">
          {nav.pinned.map((c) => (
            <ChatLink key={c.key} chat={c} pathname={pathname} onNavigate={onNavigate} />
          ))}
        </Section>
      ) : null}
      {nav.projects.length ? (
        <Section title="Projects">
          {nav.projects.map((f) => (
            <Folder key={f.key} folder={f} pathname={pathname} onNavigate={onNavigate} />
          ))}
        </Section>
      ) : null}
      {nav.groups.length ? (
        <Section title="Groups">
          {nav.groups.map((f) => (
            <Folder key={f.key} folder={f} pathname={pathname} onNavigate={onNavigate} />
          ))}
        </Section>
      ) : null}
      {nav.recent.length ? (
        <Section title="Recent">
          {nav.recent.map((c) => (
            <ChatLink key={c.key} chat={c} pathname={pathname} onNavigate={onNavigate} />
          ))}
        </Section>
      ) : null}
    </nav>
  );
}

function SearchBox({ id }: { id: string }) {
  return (
    <form method="get" action="/dashboard/search" role="search">
      <label htmlFor={id} className="sr-only">
        Search chats and messages
      </label>
      <input
        id={id}
        type="search"
        name="q"
        maxLength={100}
        placeholder="Search (Ctrl + K)"
        className="border-border-strong bg-surface w-full rounded-lg border px-3 py-1.5 text-base sm:text-sm"
      />
    </form>
  );
}

export function Sidebar({
  profile,
  badges,
  chats = null,
}: {
  profile: ReactNode;
  badges?: Record<string, number>;
  /** Pinned · Projects · Groups · Recent (null: could not load; the rest still works). */
  chats?: ChatNav | null;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  const nav = (
    <nav className="flex flex-col gap-0.5" aria-label="ThreadLink">
      {NAV.map((item) => {
        const active = isActive(pathname, item.href);
        const badge = badges?.[item.href];
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            onClick={close}
            className={cx(
              "flex items-center justify-between rounded-lg px-3 py-2 text-sm transition-colors",
              active
                ? "bg-accent-soft text-accent font-medium"
                : "text-muted hover:bg-surface-muted hover:text-foreground",
            )}
          >
            {item.label}
            {badge ? (
              <span className="bg-accent text-accent-foreground rounded-full px-1.5 text-[0.7rem] font-semibold">
                {badge}
                <span className="sr-only"> waiting</span>
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );

  const logo = (
    <span
      aria-hidden
      className="bg-accent text-accent-foreground flex size-6 items-center justify-center rounded-md text-xs"
    >
      ⇄
    </span>
  );

  return (
    <>
      {/* Mobile bar */}
      <div className="border-border bg-surface sticky top-0 z-20 flex items-center justify-between border-b px-4 py-3 lg:hidden">
        <Link href="/dashboard" className="flex items-center gap-2 font-semibold">
          {logo}
          ThreadLink
        </Link>
        <button
          type="button"
          aria-expanded={open}
          aria-controls="tl-nav"
          onClick={() => setOpen((v) => !v)}
          className="border-border-strong rounded-lg border px-3 py-1.5 text-sm"
        >
          {open ? "Close" : "Menu"}
        </button>
      </div>
      {open ? (
        <div
          id="tl-nav"
          className="border-border bg-surface max-h-[80dvh] overflow-y-auto border-b p-3 lg:hidden"
        >
          <div className="flex flex-col gap-2">
            <Link
              href="/dashboard/chats#new-chat"
              onClick={close}
              className="bg-accent text-accent-foreground rounded-lg px-3 py-2 text-center text-sm font-medium"
            >
              New chat
            </Link>
            <SearchBox id={`${SEARCH_ID}-mobile`} />
            {nav}
            {chats ? <ChatSections nav={chats} pathname={pathname} onNavigate={close} /> : null}
          </div>
          <div className="border-border mt-3 border-t pt-3">{profile}</div>
        </div>
      ) : null}

      {/* Desktop rail */}
      <aside className="border-border bg-surface sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r p-4 lg:flex">
        <Link
          href="/dashboard"
          className="mb-4 flex items-center gap-2 px-2 font-semibold tracking-tight"
        >
          {logo}
          ThreadLink
        </Link>
        <div className="mb-3 flex flex-col gap-2">
          <Link
            href="/dashboard/chats#new-chat"
            id="tl-new-chat"
            className="bg-accent text-accent-foreground hover:bg-accent-hover rounded-lg px-3 py-2 text-center text-sm font-medium"
          >
            New chat
          </Link>
          <SearchBox id={SEARCH_ID} />
        </div>
        {nav}
        <div className="-mx-1 mt-2 min-h-0 flex-1 overflow-y-auto px-1">
          {chats ? <ChatSections nav={chats} pathname={pathname} onNavigate={close} /> : null}
        </div>
        <div className="pt-2">{profile}</div>
      </aside>
    </>
  );
}
