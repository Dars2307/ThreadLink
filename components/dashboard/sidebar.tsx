"use client";

import {
  Bell,
  Bot,
  ChevronRight,
  ChevronsUpDown,
  Ellipsis,
  FolderKanban,
  House,
  Link2,
  Menu,
  MessagesSquare,
  Search,
  Settings2,
  SquarePen,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import { isChatRoute } from "@/components/dashboard/frame";
import { cx } from "@/components/ui";
import type { ChatNav, NavChat } from "@/lib/dashboard/nav";

/**
 * Primary navigation (0.11 design canvas, shadcn/ui "sidebar inset" block):
 * a 256 px rail sitting on the app backdrop. Workspace: Home, Chats
 * (collapsible list of chats), Agents, Notifications; Projects; Settings and
 * the account at the foot. Home is also the logo.
 */
export const NAV = [
  { href: "/dashboard/chats", label: "Chats" },
  { href: "/dashboard/projects", label: "Projects" },
  { href: "/dashboard/agents", label: "Agents" },
  { href: "/dashboard/notifications", label: "Notifications" },
  { href: "/dashboard/settings", label: "Settings" },
] as const;

/** The sidebar search control id (Ctrl+K opens search). */
export const SEARCH_ID = "tl-search";

/**
 * The chat header's sidebar button dispatches this window event: on phones it
 * opens the navigation sheet, on wide screens it collapses/expands the rail.
 */
export const OPEN_NAV_EVENT = "tl:open-nav";

const WIDE = "(min-width: 1024px)";

/** Home matches exactly; every other section also owns its sub-pages. */
function isActive(pathname: string, href: string): boolean {
  if (href === "/dashboard") return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

const ROW =
  "flex h-8 min-w-0 items-center gap-2 rounded-md px-2 text-sm text-foreground transition-colors hover:bg-active motion-reduce:transition-none";

function NavRow({
  href,
  icon: Icon,
  label,
  active,
  onNavigate,
  trailing,
}: {
  href: string;
  icon: LucideIcon;
  label: string;
  active: boolean;
  onNavigate: () => void;
  trailing?: ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      onClick={onNavigate}
      className={cx(ROW, active && "bg-active font-medium")}
    >
      <Icon aria-hidden className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing}
    </Link>
  );
}

function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <div className="text-subtle flex h-7 items-center px-2 text-xs font-medium">{children}</div>
  );
}

function ChatRow({
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
        "hover:bg-active flex h-7 min-w-0 items-center justify-between gap-2 rounded-md px-2 text-[13px] transition-colors motion-reduce:transition-none",
        active
          ? "bg-active text-foreground font-medium"
          : chat.unread
            ? "text-foreground"
            : "text-muted hover:text-foreground",
      )}
    >
      <span className={cx("min-w-0 flex-1 truncate", chat.unread && !active && "font-semibold")}>
        {chat.name}
      </span>
      {chat.needsAttention ? (
        <span className="text-warning shrink-0 text-[11px] font-semibold">Needs you</span>
      ) : chat.working ? (
        <span className="flex shrink-0 items-center" title="Working">
          <span
            aria-hidden
            className="bg-success size-1.5 rounded-full shadow-[0_0_0_3px_var(--ok-ring)]"
          />
          <span className="sr-only">Working</span>
        </span>
      ) : chat.unread ? (
        <span className="bg-accent text-accent-foreground flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold">
          New
        </span>
      ) : null}
    </Link>
  );
}

const LOGO = (
  <svg
    width="17"
    height="17"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M9 7H7a5 5 0 0 0 0 10h2" />
    <path d="M15 7h2a5 5 0 0 1 0 10h-2" />
    <path d="M8 12h8" />
  </svg>
);

function Rail({
  pathname,
  chats,
  badges,
  profile,
  onNavigate,
  searchId,
  newChatId,
}: {
  pathname: string;
  chats: ChatNav | null;
  badges?: Record<string, number>;
  profile: ReactNode;
  onNavigate: () => void;
  searchId: string;
  newChatId?: string;
}) {
  const onChats = isActive(pathname, "/dashboard/chats");
  const [chatsOpen, setChatsOpen] = useState(true);
  const list = chats
    ? [...chats.pinned, ...chats.recent.filter((r) => !chats.pinned.some((p) => p.href === r.href))]
    : [];
  const projects = chats?.projects ?? [];
  const notifications = badges?.["/dashboard/notifications"];
  const agents = badges?.["/dashboard/agents"];

  return (
    <>
      <Link
        href="/dashboard"
        onClick={onNavigate}
        className="hover:bg-active flex h-12 shrink-0 items-center gap-2.5 rounded-lg px-2 transition-colors motion-reduce:transition-none"
      >
        <span className="bg-accent text-accent-foreground shadow-glow flex size-8 shrink-0 items-center justify-center rounded-lg">
          {LOGO}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-px">
          <span className="text-sm leading-tight font-semibold">ThreadLink</span>
          <span className="text-subtle text-xs leading-tight">Web</span>
        </span>
        <ChevronsUpDown aria-hidden className="text-subtle size-4" />
      </Link>

      <div className="flex shrink-0 flex-col gap-1 pb-1">
        <Link
          id={searchId}
          href="/dashboard/search"
          onClick={onNavigate}
          className="border-border bg-card text-subtle hover:text-foreground flex h-[34px] items-center gap-2 rounded-lg border px-2.5 text-[13px] shadow-[0_1px_2px_rgb(16_16_24/0.05)]"
        >
          <Search aria-hidden className="size-[15px]" />
          <span className="flex-1">Search chats</span>
          <kbd className="border-border rounded border px-1.5 font-mono text-[11px]">Ctrl K</kbd>
        </Link>
        <Link href="/dashboard/chats#new-chat" id={newChatId} onClick={onNavigate} className={ROW}>
          <SquarePen aria-hidden className="size-4" />
          New chat
        </Link>
      </div>

      <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-1">
        <nav aria-label="Workspace" className="flex flex-col gap-px">
          <GroupLabel>Workspace</GroupLabel>
          <NavRow
            href="/dashboard"
            icon={House}
            label="Home"
            active={isActive(pathname, "/dashboard")}
            onNavigate={onNavigate}
          />
          <div className={cx(ROW, "p-0 pr-0.5", onChats && "font-medium")}>
            <Link
              href="/dashboard/chats"
              onClick={onNavigate}
              aria-current={pathname === "/dashboard/chats" ? "page" : undefined}
              className="flex h-8 min-w-0 flex-1 items-center gap-2 pl-2"
            >
              <MessagesSquare aria-hidden className="size-4 shrink-0" />
              <span className="truncate">Chats</span>
            </Link>
            <button
              type="button"
              onClick={() => setChatsOpen((v) => !v)}
              aria-expanded={chatsOpen}
              aria-controls="tl-nav-chats"
              aria-label={chatsOpen ? "Hide chats" : "Show chats"}
              className="text-subtle hover:text-foreground flex size-7 items-center justify-center rounded-md"
            >
              <ChevronRight
                aria-hidden
                className={cx(
                  "size-[15px] transition-transform duration-200 motion-reduce:transition-none",
                  chatsOpen && "rotate-90",
                )}
              />
            </button>
          </div>
          {chatsOpen ? (
            <div
              id="tl-nav-chats"
              className="border-border mt-px mb-1 ml-[15px] flex flex-col gap-px border-l py-0.5 pl-2.5"
            >
              {list.length ? (
                list.map((c) => (
                  <ChatRow key={c.key} chat={c} pathname={pathname} onNavigate={onNavigate} />
                ))
              ) : (
                <Link
                  href="/dashboard/chats#new-chat"
                  onClick={onNavigate}
                  className="text-muted hover:bg-active flex h-7 items-center rounded-md px-2 text-[13px]"
                >
                  Start your first chat
                </Link>
              )}
            </div>
          ) : null}
          <NavRow
            href="/dashboard/agents"
            icon={Bot}
            label="Agents"
            active={isActive(pathname, "/dashboard/agents")}
            onNavigate={onNavigate}
            trailing={
              agents ? (
                <span className="text-subtle text-xs">
                  {agents}
                  <span className="sr-only"> waiting</span>
                </span>
              ) : null
            }
          />
          <NavRow
            href="/dashboard/notifications"
            icon={Bell}
            label="Notifications"
            active={isActive(pathname, "/dashboard/notifications")}
            onNavigate={onNavigate}
            trailing={
              notifications ? (
                <span className="text-subtle text-xs">
                  {notifications}
                  <span className="sr-only"> waiting</span>
                </span>
              ) : null
            }
          />
        </nav>

        <nav aria-label="Projects" className="flex flex-col gap-px">
          <GroupLabel>Projects</GroupLabel>
          {projects
            .slice(0, 6)
            .map((f) =>
              f.href ? (
                <NavRow
                  key={f.key}
                  href={f.href}
                  icon={FolderKanban}
                  label={f.name}
                  active={isActive(pathname, f.href)}
                  onNavigate={onNavigate}
                />
              ) : null,
            )}
          {chats && chats.groups.length
            ? chats.groups
                .slice(0, 4)
                .map((g) =>
                  g.href ? (
                    <NavRow
                      key={g.key}
                      href={g.href}
                      icon={Link2}
                      label={g.name}
                      active={false}
                      onNavigate={onNavigate}
                    />
                  ) : null,
                )
            : null}
          <Link
            href="/dashboard/projects"
            onClick={onNavigate}
            aria-current={pathname === "/dashboard/projects" ? "page" : undefined}
            className={cx(ROW, "text-subtle", pathname === "/dashboard/projects" && "bg-active")}
          >
            <Ellipsis aria-hidden className="size-4" />
            {projects.length ? "More" : "All projects"}
          </Link>
        </nav>
      </div>

      <div className="flex shrink-0 flex-col gap-px">
        <NavRow
          href="/dashboard/settings"
          icon={Settings2}
          label="Settings"
          active={isActive(pathname, "/dashboard/settings")}
          onNavigate={onNavigate}
        />
        {profile}
      </div>
    </>
  );
}

function subscribeWide(cb: () => void) {
  const mq = window.matchMedia?.(WIDE);
  mq?.addEventListener("change", cb);
  return () => mq?.removeEventListener("change", cb);
}

export function Sidebar({
  profile,
  badges,
  chats = null,
}: {
  profile: ReactNode;
  badges?: Record<string, number>;
  /** Pinned · Recent chats, Projects, Groups (null: could not load; the rest still works). */
  chats?: ChatNav | null;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const sheet = useRef<HTMLDivElement>(null);
  const close = () => setOpen(false);
  const onChat = isChatRoute(pathname);
  const wide = useSyncExternalStore(
    subscribeWide,
    () => window.matchMedia?.(WIDE).matches ?? true,
    () => true,
  );

  // The chat header's sidebar button: a sheet on phones, collapse on wide screens.
  useEffect(() => {
    const onToggle = () => {
      if (window.matchMedia?.(WIDE).matches) setCollapsed((c) => !c);
      else setOpen(true);
    };
    window.addEventListener(OPEN_NAV_EVENT, onToggle);
    return () => window.removeEventListener(OPEN_NAV_EVENT, onToggle);
  }, []);

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement;
    sheet.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [open]);

  return (
    <>
      {/* Phones, outside a chat (a chat has its own header with the menu button). */}
      {onChat ? null : (
        <div className="tl-head border-line-soft sticky top-0 z-20 flex h-14 items-center justify-between border-b px-2 lg:hidden">
          <button
            type="button"
            aria-expanded={open}
            aria-controls="tl-nav"
            aria-label="Open navigation"
            onClick={() => setOpen(true)}
            className="text-foreground hover:bg-active flex size-11 items-center justify-center rounded-[10px]"
          >
            <Menu aria-hidden className="size-5" />
          </button>
          <Link href="/dashboard" className="flex items-center gap-2 font-semibold">
            <span className="bg-accent text-accent-foreground flex size-7 items-center justify-center rounded-lg">
              {LOGO}
            </span>
            ThreadLink
          </Link>
          <span className="size-11" aria-hidden />
        </div>
      )}
      {open && !wide ? (
        <div className="fixed inset-0 z-50" role="presentation">
          <button
            type="button"
            aria-label="Close navigation"
            tabIndex={-1}
            className="absolute inset-0 bg-black/30"
            onClick={close}
          />
          <div
            id="tl-nav"
            ref={sheet}
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            tabIndex={-1}
            className="tl-side border-line-soft relative flex h-full w-[min(17rem,88vw)] flex-col gap-2 border-r p-2 pt-[max(0.5rem,env(safe-area-inset-top))] pb-[max(0.5rem,env(safe-area-inset-bottom))] outline-none"
          >
            <Rail
              pathname={pathname}
              chats={chats}
              badges={badges}
              profile={profile}
              onNavigate={close}
              searchId={`${SEARCH_ID}-mobile`}
            />
          </div>
        </div>
      ) : null}

      {/* Wide screens: the rail sits on the backdrop (no panel of its own). */}
      {collapsed ? (
        <div aria-hidden className="hidden w-2 shrink-0 lg:block" />
      ) : (
        <aside
          aria-label="Sidebar"
          className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col gap-2 p-2 lg:flex"
        >
          <Rail
            pathname={pathname}
            chats={chats}
            badges={badges}
            profile={profile}
            onNavigate={close}
            searchId={SEARCH_ID}
            newChatId="tl-new-chat"
          />
        </aside>
      )}
    </>
  );
}
