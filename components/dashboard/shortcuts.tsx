"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { buttonStyles } from "@/components/ui";
import { adjacentChat, SHORTCUTS, shortcutFor } from "@/lib/dashboard/shortcuts";

const COMPOSER_ID = "tl-composer";
const SEARCH_IDS = ["tl-search", "tl-search-mobile"];

function editable(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

/**
 * App-wide keyboard shortcuts (brief §82). Only modifier shortcuts work while
 * typing; "/" and "?" never steal a character from a text field.
 */
export function KeyboardShortcuts({ chatOrder }: { chatOrder: string[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const [help, setHelp] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const action = shortcutFor({
        key: e.key,
        altKey: e.altKey,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        shiftKey: e.shiftKey,
        inEditable: editable(document.activeElement),
      });
      if (!action) return;
      const onChat = /^\/dashboard\/chats\/[^/]+$/.test(pathname);
      const tab = (t: string) => {
        if (!onChat) return;
        const q = new URLSearchParams(search.toString());
        if (t === "chat") q.delete("tab");
        else q.set("tab", t);
        const qs = q.toString();
        router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
      };
      switch (action) {
        case "search": {
          // 0.11: the sidebar's search is a link now; only a visible text box takes focus.
          const box = SEARCH_IDS.map((id) => document.getElementById(id)).find(
            (el) => el instanceof HTMLInputElement && el.offsetParent !== null,
          );
          e.preventDefault();
          if (box) box.focus();
          else router.push("/dashboard/search");
          return;
        }
        case "new_chat":
          e.preventDefault();
          router.push("/dashboard/chats#new-chat");
          return;
        case "next_chat":
        case "prev_chat": {
          const next = adjacentChat(chatOrder, pathname, action === "next_chat" ? 1 : -1);
          if (next) {
            e.preventDefault();
            router.push(next);
          }
          return;
        }
        case "focus_composer": {
          const el = document.getElementById(COMPOSER_ID);
          if (el) {
            e.preventDefault();
            el.focus();
          }
          return;
        }
        case "tab_chat":
          e.preventDefault();
          tab("chat");
          return;
        case "tab_progress":
          e.preventDefault();
          tab("progress");
          return;
        case "tab_details":
          e.preventDefault();
          tab("details");
          return;
        case "help":
          e.preventDefault();
          setHelp(true);
          return;
        case "escape":
          if (help) setHelp(false);
          else
            document.querySelectorAll("details[open]").forEach((d) => {
              if (d.contains(document.activeElement) || d.querySelector(".absolute"))
                d.removeAttribute("open");
            });
          return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router, pathname, search, chatOrder, help]);

  useEffect(() => {
    if (help) dialog.current?.focus();
  }, [help]);

  if (!help) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="presentation">
      <button
        type="button"
        aria-label="Close"
        tabIndex={-1}
        className="absolute inset-0 bg-black/30"
        onClick={() => setHelp(false)}
      />
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="kb-title"
        tabIndex={-1}
        className="border-border bg-surface shadow-card relative w-full max-w-md rounded-2xl border p-5 outline-none"
      >
        <h2 id="kb-title" className="pb-3 text-base font-semibold">
          Keyboard shortcuts
        </h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          {SHORTCUTS.map((s) => (
            <div key={s.keys} className="contents">
              <dt>
                <kbd className="border-border bg-surface-muted rounded border px-1.5 py-0.5 font-mono text-xs">
                  {s.keys}
                </kbd>
              </dt>
              <dd className="text-muted">{s.action}</dd>
            </div>
          ))}
        </dl>
        <button
          type="button"
          className={`${buttonStyles.secondary} mt-4`}
          onClick={() => setHelp(false)}
        >
          Close
        </button>
      </div>
    </div>
  );
}
