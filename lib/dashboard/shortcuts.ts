/**
 * Keyboard shortcuts (brief §82) and chat switching. Pure and dependency-free
 * so the browser can import it.
 */

/** The chat to switch to with Alt+↑/↓, or null. */
export function adjacentChat(order: string[], current: string, dir: 1 | -1): string | null {
  if (order.length === 0) return null;
  const i = order.indexOf(current);
  if (i < 0) return dir === 1 ? order[0]! : order[order.length - 1]!;
  const j = i + dir;
  return j >= 0 && j < order.length ? order[j]! : null;
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------

export type ShortcutAction =
  | "new_chat"
  | "search"
  | "next_chat"
  | "prev_chat"
  | "focus_composer"
  | "tab_chat"
  | "tab_progress"
  | "tab_details"
  | "help"
  | "escape";

export const SHORTCUTS: { keys: string; action: string }[] = [
  { keys: "Alt + N", action: "New chat" },
  { keys: "Ctrl + K", action: "Search" },
  { keys: "Alt + ↑ / Alt + ↓", action: "Previous / next chat" },
  { keys: "/", action: "Focus the message box" },
  { keys: "Enter", action: "Send (Shift + Enter for a new line)" },
  { keys: "@", action: "Mention an agent (in the message box)" },
  { keys: "Esc", action: "Close a panel or leave the message box" },
  { keys: "PageUp / PageDown / Home / End", action: "Scroll the chat (when it has focus)" },
  { keys: "Alt + 1 / 2 / 3", action: "Chat · Progress panel · Details panel" },
  { keys: "?", action: "Show these shortcuts" },
];

export type KeyInput = {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  /** True while focus is in a text field (then only modifier shortcuts apply). */
  inEditable: boolean;
};

export function shortcutFor(e: KeyInput): ShortcutAction | null {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.altKey && e.key.toLowerCase() === "k") return "search";
  if (e.altKey && !mod) {
    const k = e.key.toLowerCase();
    if (k === "n" || e.key === "ñ") return "new_chat";
    if (e.key === "ArrowDown") return "next_chat";
    if (e.key === "ArrowUp") return "prev_chat";
    if (e.key === "1") return "tab_chat";
    if (e.key === "2") return "tab_progress";
    if (e.key === "3") return "tab_details";
  }
  if (e.key === "Escape") return "escape";
  if (e.inEditable || mod || e.altKey) return null;
  if (e.key === "/") return "focus_composer";
  if (e.key === "?") return "help";
  return null;
}
