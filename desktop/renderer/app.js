/* ThreadLink desktop renderer: sandboxed, no Node APIs, talks only through window.threadlink. */
const api = window.threadlink;
const view = document.getElementById("view");
let state = null;
let section = "home";
let selectedWorkspace = null;
/** The mode chosen in the attach flow. Background is the everyday choice. */
let attachMode = "worker";
/** Link decisions in flight, so a re-render cannot resend one. */
const decided = new Set();
/** localBindingRef of the conversation whose mode is being changed, if any. */
let changing = null;
/**
 * Which render pass is current. An async pass awaits the Runtime, and a new
 * snapshot can start another pass meanwhile; without this the stale one
 * carries on and binds a SECOND listener to the same button, so one click
 * opened two folder pickers.
 */
let pass = 0;
/**
 * Declared plans as ThreadLink last returned them. The server is the source
 * of truth: this is only what the last answer said, and it is re-read every
 * time Settings is opened and after every save.
 */
const plans = { views: null, stale: true, loading: false, failed: false, fromCache: false };
/** A plan chosen in the select but not saved yet, per provider. */
const planDraft = {};
/** "Saved" / "Couldn't save…", per provider, until Settings is left. */
const planNote = {};
/** Providers whose save is in flight, so a re-render cannot send it twice. */
const planSaving = new Set();
/** Which agent's settings Agents shows. Claude Code first: it has the most. */
let agentTab = "claude-code";

// ------------------------------------------------------------------ icons

/**
 * Lucide icons (https://lucide.dev, ISC licence — see LUCIDE-LICENSE.txt),
 * inlined as data and built with DOM APIs: never innerHTML. A string is a
 * path's `d`; an array is [tag, attributes].
 */
const ICONS = {
  house: [
    "M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8",
    "M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  ],
  "messages-square": [
    "M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z",
    "M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1",
  ],
  bot: [
    "M12 8V4H8",
    ["rect", { width: 16, height: 12, x: 4, y: 8, rx: 2 }],
    "M2 14h2",
    "M20 14h2",
    "M15 13v2",
    "M9 13v2",
  ],
  bell: [
    "M10.268 21a2 2 0 0 0 3.464 0",
    "M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326",
  ],
  monitor: [
    ["rect", { width: 20, height: 14, x: 2, y: 3, rx: 2 }],
    ["line", { x1: 8, x2: 16, y1: 21, y2: 21 }],
    ["line", { x1: 12, x2: 12, y1: 17, y2: 21 }],
  ],
  "folder-kanban": [
    "M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z",
    "M8 10v4",
    "M12 10v2",
    "M16 10v6",
  ],
  folder: [
    "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z",
  ],
  "settings-2": [
    "M20 7h-9",
    "M14 17H5",
    ["circle", { cx: 17, cy: 17, r: 3 }],
    ["circle", { cx: 7, cy: 7, r: 3 }],
  ],
  search: [["circle", { cx: 11, cy: 11, r: 8 }], "m21 21-4.3-4.3"],
  "square-pen": [
    "M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7",
    "M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z",
  ],
  "chevrons-up-down": ["m7 15 5 5 5-5", "m7 9 5-5 5 5"],
  "chevron-right": ["m9 18 6-6-6-6"],
  "panel-left": [["rect", { width: 18, height: 18, x: 3, y: 3, rx: 2 }], "M9 3v18"],
  "panel-right": [["rect", { width: 18, height: 18, x: 3, y: 3, rx: 2 }], "M15 3v18"],
  pause: [
    ["rect", { x: 14, y: 4, width: 4, height: 16, rx: 1 }],
    ["rect", { x: 6, y: 4, width: 4, height: 16, rx: 1 }],
  ],
  play: ["M6 3 20 12 6 21 6 3z"],
  "rotate-ccw": ["M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8", "M3 3v5h5"],
  "file-text": [
    "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z",
    "M14 2v4a2 2 0 0 0 2 2h4",
    "M10 9H8",
    "M16 13H8",
    "M16 17H8",
  ],
  activity: [
    "M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2",
  ],
  "shield-check": [
    "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z",
    "m9 12 2 2 4-4",
  ],
  reply: [["polyline", { points: "9 17 4 12 9 7" }], "M20 18v-2a4 4 0 0 0-4-4H4"],
  "triangle-alert": [
    "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3",
    "M12 9v4",
    "M12 17h.01",
  ],
  check: ["M20 6 9 17l-5-5"],
  wrench: [
    "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z",
  ],
  x: ["M18 6 6 18", "m6 6 12 12"],
  "arrow-down": ["M12 5v14", "m19 12-7 7-7-7"],
  logo: ["M9 7H7a5 5 0 0 0 0 10h2", "M15 7h2a5 5 0 0 1 0 10h-2", "M8 12h8"],
};

const SVG_NS = "http://www.w3.org/2000/svg";

/** One Lucide icon as an inline SVG element (decorative: aria-hidden). */
function icon(name, size = 16, strokeWidth = 2) {
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [k, v] of [
    ["width", size],
    ["height", size],
    ["viewBox", "0 0 24 24"],
    ["fill", "none"],
    ["stroke", "currentColor"],
    ["stroke-width", strokeWidth],
    ["stroke-linecap", "round"],
    ["stroke-linejoin", "round"],
    ["aria-hidden", "true"],
    ["focusable", "false"],
  ])
    svg.setAttribute(k, String(v));
  for (const part of ICONS[name] ?? []) {
    const [tag, attrs] = typeof part === "string" ? ["path", { d: part }] : part;
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    svg.append(node);
  }
  return svg;
}

// ------------------------------------------------------------- appearance

const THEMES = ["system", "light", "dark"];
const BACKDROPS = ["aurora", "dusk", "grid", "none"];
const darkQuery =
  typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

/**
 * Theme (the OS unless overridden), backdrop and motion, from this device's
 * settings. Cheap: three attributes on <html>, no re-render.
 */
function applyAppearance() {
  const root = document.documentElement;
  const s = state?.settings ?? {};
  const theme = THEMES.includes(s.theme) ? s.theme : "system";
  const dark = theme === "dark" || (theme === "system" && darkQuery?.matches === true);
  root.classList.toggle("dark", dark);
  root.dataset.backdrop = BACKDROPS.includes(s.backdrop) ? s.backdrop : "dusk";
  root.classList.toggle("bg-still", s.animate === false);
  root.classList.toggle("bg-paused", document.visibilityState === "hidden");
}

darkQuery?.addEventListener?.("change", () => applyAppearance());
// Hidden or minimised: every animation pauses (the compositor goes idle).
document.addEventListener("visibilitychange", () =>
  document.documentElement.classList.toggle("bg-paused", document.visibilityState === "hidden"),
);

/** Changes an appearance setting now, then saves it through main (validated there). */
function setAppearance(patch) {
  state = { ...state, settings: { ...(state?.settings ?? {}), ...patch } };
  applyAppearance();
  void api.setSettings?.(patch);
}

const el = (id) => document.getElementById(id);
const tpl = (name) => document.getElementById(`tpl-${name}`).content.cloneNode(true);

/** The same places as ThreadLink on the web (0.11 §9), plus This computer. */
const SECTIONS = [
  { id: "home", label: "Home", title: "Home", icon: "house" },
  { id: "chats", label: "Chats", title: "Chats", icon: "messages-square" },
  { id: "agents", label: "Agents", title: "Agents", icon: "bot" },
  { id: "notifications", label: "Notifications", title: "Notifications", icon: "bell" },
  { id: "runtime", label: "This computer", title: "This computer", icon: "monitor" },
  { id: "projects", label: "Projects", title: "Projects", icon: "folder-kanban" },
  { id: "settings", label: "Settings", title: "Settings", icon: "settings-2" },
];

/** Sidebar state: collapsed (the inset's toggle), chats sub-list open, search text. */
const sidebar = { collapsed: false, chatsOpen: true, filter: "" };

/**
 * The three ways a request can run, in words that are true. None of them opens
 * a window: ThreadLink never shows or drives a visible Claude Code session.
 */
const MODES = {
  worker: {
    name: "Background worker",
    why:
      "Default. Works while Claude Code is open: ThreadLink runs its own worker in this " +
      "project, so your open conversation is left alone.",
  },
  resume: {
    name: "Exact conversation",
    why:
      "Uses one of your existing Claude conversations. Only works when that conversation " +
      "isn't open in Claude Code.",
  },
  fresh: {
    name: "New headless session",
    why: "Doesn't open a window; each request starts a fresh session.",
  },
};

/** Why exact mode cannot be chosen in the attach flow, or null when it can. */
function exactUnavailable(conversations) {
  if (!conversations.length) return "No Claude Code conversations found in this folder yet.";
  if (!conversations.some((c) => !c.attached))
    return "Every Claude Code conversation in this folder is already attached.";
  return null;
}

const modeName = (mode) => MODES[mode]?.name ?? "Claude conversation";

function ago(iso) {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return s < 172800 ? "yesterday" : `${Math.round(s / 86400)} days ago`;
}

/** Trouble the user can act on, rather than something to sit and watch. */
function attention(s) {
  const snap = s.snapshot;
  if (!snap) return null;
  if (snap.status === "wrong-address")
    return "This computer was pointed at an old ThreadLink address. Sign in again to finish moving to the current one.";
  if (snap.status === "signed-out") return "This computer's ThreadLink sign-in has expired.";
  if (snap.status === "revoked") return "This computer was disconnected in ThreadLink.";
  if (snap.status === "offline" && snap.needsAttention)
    return "ThreadLink is not answering. It is still retrying — you can also sign in again now.";
  return null;
}

/**
 * The one global status: what the agents are doing ("2 agents ready",
 * "1 agent working", "Execution host online"). Never one provider's window
 * state -- that is a detail of one binding, shown under Agents → Claude Code.
 */
function statusOf(s) {
  if (!s.signedIn) return { title: "Not connected", tone: "warn", detail: "" };
  const snap = s.snapshot;
  if (snap?.status === "online") {
    const title = s.agentsLine || "Execution host online";
    return {
      title,
      tone: /working/.test(title) ? "busy" : "ready",
      detail: snap.runtime?.label ?? snap.identity?.label ?? "",
    };
  }
  const map = {
    paused: { title: "Paused", tone: "warn" },
    offline: { title: "Reconnecting…", tone: "warn" },
    starting: { title: "Starting…", tone: "warn" },
    "signed-out": { title: "Sign in again", tone: "warn" },
    revoked: { title: "Disconnected in ThreadLink", tone: "off" },
  };
  return { ...(map[snap?.status] ?? { title: "Idle", tone: "off" }), detail: snap?.detail ?? "" };
}

/** What one attached conversation is doing, in the user's words. */
function conversationStatus(c) {
  // Only an exact-conversation binding waits while its conversation is open.
  if (c.mode === "resume" && c.busy) return { label: "Waiting: open in Claude Code", tone: "busy" };
  return { label: "Ready", tone: "ready" };
}

function render() {
  if (!state) return;
  applyAppearance();
  const status = statusOf(state);
  el("status-title").textContent = status.title;
  el("status-dot").className = `ping ${PING_TONE[status.tone] ?? "off"}`;
  el("rail-status").textContent = status.title;
  el("rail-dot").className = `dot ${status.tone}`;
  el("footer-detail").textContent = state.error ?? state.notice ?? status.detail ?? "";

  // An open chat is never rebuilt by a state snapshot: its timeline grows by
  // appending (see the chat section). Only the chrome around it is refreshed.
  if (section === "chats" && chatView.mounted && state.signedIn && !state.pendingSignIn) {
    renderNav();
    if (chatView.drawer === "progress") renderDrawer();
    return;
  }
  stopChat();

  view.replaceChildren();
  const mine = ++pass;
  const solo = (render) => {
    el("shell").className = "shell solo";
    el("shell").classList.remove("sidebar-collapsed");
    el("page-title").textContent = "ThreadLink";
    el("page-sub").textContent = "";
    render();
  };
  if (state.pendingSignIn) return solo(renderWaiting);
  const why = attention(state);
  if (why) return solo(() => renderReconnect(why));
  if (!state.signedIn) return solo(renderSignIn);

  // An open chat is one screen with one scrolling timeline: no page header, no footer.
  el("shell").className = section === "chats" && chatView.id ? "shell chat-route" : "shell";
  el("shell").classList.toggle("sidebar-collapsed", sidebar.collapsed);
  renderNav();
  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];
  el("page-title").textContent = section === "attach" ? "Attach a conversation" : current.title;
  el("page-sub").textContent = subtitleFor();
  if (section === "attach") return void renderAttach(mine);
  if (section === "agents") return renderAgents();
  if (section === "chats") return renderChats();
  if (section === "projects") return renderProjects();
  if (section === "runtime") return renderRuntime();
  if (section === "notifications") return renderNotifications();
  if (section === "settings") return renderSettings();
  return renderHome();
}

function subtitleFor() {
  const snap = state.snapshot;
  if (section === "home") return snap?.runtime?.label ?? snap?.identity?.label ?? "";
  if (section === "agents") return state.agentsLine ?? "";
  if (section === "projects") return "Each project runs on one computer";
  if (section === "runtime") return snap?.identity?.platform ?? "";
  return "";
}

/** Status tone → ping dot class. */
const PING_TONE = { ready: "", busy: "run", warn: "wait", off: "off" };

/** A sidebar item button (shadcn inset sidebar). */
function sbItem(id, label, iconName) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "sb-item nav-item";
  b.dataset.section = id;
  b.append(icon(iconName));
  const text = document.createElement("span");
  text.className = "sb-text";
  text.textContent = label;
  b.append(text);
  const here = id === section || (section === "attach" && id === "agents");
  b.setAttribute("aria-current", here ? "true" : "false");
  return b;
}

/** The parts of the sidebar built once (the search keeps focus across updates). */
function ensureSidebarTop() {
  const nav = el("nav");
  if (el("sb-search")) return nav;
  nav.replaceChildren();
  const switcher = document.createElement("button");
  switcher.type = "button";
  switcher.className = "sb-switcher";
  switcher.title = "This computer";
  const logo = document.createElement("span");
  logo.className = "sb-logo";
  logo.append(icon("logo", 17, 2.2));
  const names = document.createElement("span");
  names.className = "sb-names";
  const b = document.createElement("b");
  b.textContent = "ThreadLink";
  const where = document.createElement("small");
  where.id = "sb-where";
  names.append(b, where);
  const chev = icon("chevrons-up-down");
  chev.classList.add("sb-chevron");
  switcher.append(logo, names, chev);
  switcher.addEventListener("click", () => go("runtime"));

  const top = document.createElement("div");
  top.className = "sb-top";
  const search = document.createElement("label");
  search.className = "sb-search";
  search.append(icon("search", 15));
  const input = document.createElement("input");
  input.id = "sb-search";
  input.type = "search";
  input.placeholder = "Search chats";
  input.setAttribute("aria-label", "Search chats");
  input.maxLength = 100;
  input.addEventListener("input", () => {
    sidebar.filter = input.value.trim().toLowerCase();
    if (sidebar.filter) sidebar.chatsOpen = true;
    renderNav();
  });
  const kbd = document.createElement("kbd");
  kbd.textContent = "Ctrl K";
  search.append(input, kbd);
  const newChat = document.createElement("button");
  newChat.type = "button";
  newChat.id = "sb-new-chat";
  newChat.className = "sb-item";
  newChat.append(icon("square-pen"));
  const nt = document.createElement("span");
  nt.className = "sb-text";
  nt.textContent = "New chat";
  newChat.append(nt);
  newChat.addEventListener("click", () => {
    chatView.id = null;
    go("chats");
    toggleNewChat(true);
  });
  top.append(search, newChat);

  const groups = document.createElement("div");
  groups.id = "sb-groups";
  groups.className = "stack tight";
  const spacer = document.createElement("div");
  spacer.className = "sb-spacer";
  const foot = document.createElement("div");
  foot.id = "sb-foot";
  foot.className = "sb-foot";
  nav.append(switcher, top, groups, spacer, foot);
  return nav;
}

/** The chats sub-list under Chats: active row, status dot with ring, unread pill. */
function sidebarChats() {
  const box = document.createElement("div");
  box.className = "sb-subs";
  const rows = chatList.rows.filter(
    (r) => !sidebar.filter || r.name.toLowerCase().includes(sidebar.filter),
  );
  for (const r of rows.slice(0, 12)) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `sb-sub${r.unread ? " unread" : ""}`;
    b.setAttribute(
      "aria-current",
      r.chatId === chatView.id && section === "chats" ? "true" : "false",
    );
    const t = document.createElement("span");
    t.className = "sb-text";
    t.textContent = r.name;
    b.append(t);
    if (r.unread) {
      const pill = document.createElement("span");
      pill.className = "sb-pill";
      pill.setAttribute("aria-label", "Unread");
      pill.textContent = String(Math.min(Math.max(r.unreadCount ?? 1, 1), 99));
      b.append(pill);
    } else if (r.state !== "Ready") {
      const dot = document.createElement("span");
      dot.className = `sb-dot ${r.state === "Working" ? "run" : "wait"}`;
      dot.title = r.state;
      b.append(dot);
    }
    b.addEventListener("click", () => openChat(r.chatId));
    box.append(b);
  }
  if (!rows.length) {
    const none = document.createElement("div");
    none.className = "sb-meta";
    none.textContent = sidebar.filter ? "No chats match" : "No chats yet";
    box.append(none);
  } else if (rows.length > 12) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "sb-sub";
    more.textContent = `All ${rows.length} chats`;
    more.addEventListener("click", () => {
      chatView.id = null;
      go("chats");
    });
    box.append(more);
  }
  return box;
}

function renderNav() {
  ensureSidebarTop();
  const host =
    state.host?.label ?? state.snapshot?.runtime?.label ?? state.snapshot?.identity?.label;
  el("sb-where").textContent = host ? `${host} · this computer` : "This computer";
  const waiting = state.snapshot?.pendingLinks?.length ?? 0;

  const groups = el("sb-groups");
  groups.replaceChildren();
  const workspace = document.createElement("div");
  workspace.className = "sb-group";
  const label = document.createElement("div");
  label.className = "sb-label";
  label.textContent = "Workspace";
  workspace.append(label);
  for (const s of SECTIONS.filter((x) => !["projects", "settings"].includes(x.id))) {
    const b = sbItem(s.id, s.label, s.icon);
    const count =
      s.id === "home" ? waiting : s.id === "notifications" ? chatList.needsYou.length : 0;
    if (s.id === "chats") {
      if (chatList.unread) {
        const pill = document.createElement("span");
        pill.className = "sb-pill count";
        pill.textContent = String(Math.min(chatList.unread, 99));
        b.append(pill);
      }
      const chev = icon("chevron-right", 15);
      chev.classList.add("sb-chevron");
      if (sidebar.chatsOpen) chev.classList.add("open");
      b.append(chev);
      b.setAttribute("aria-expanded", sidebar.chatsOpen ? "true" : "false");
      b.addEventListener("click", () => {
        if (section === "chats" && !chatView.id) sidebar.chatsOpen = !sidebar.chatsOpen;
        else sidebar.chatsOpen = true;
        chatView.id = null;
        go("chats");
      });
      workspace.append(b);
      if (sidebar.chatsOpen) workspace.append(sidebarChats());
      continue;
    }
    if (count) {
      const c = document.createElement("span");
      c.className = s.id === "home" ? "sb-pill count" : "sb-meta count";
      c.textContent = String(Math.min(count, 99));
      b.append(c);
    }
    if (s.id === "runtime") {
      const dot = document.createElement("span");
      const tone = statusOf(state).tone;
      dot.className = `ping ${PING_TONE[tone] ?? "off"}`;
      dot.title = statusOf(state).title;
      b.append(dot);
    }
    b.addEventListener("click", () => go(s.id));
    workspace.append(b);
  }

  const projects = document.createElement("div");
  projects.className = "sb-group";
  const pl = sbItem("projects", "Projects", "folder-kanban");
  pl.addEventListener("click", () => go("projects"));
  projects.append(pl);
  for (const p of chatList.projects.slice(0, 5)) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "sb-item";
    b.append(icon("folder"));
    const t = document.createElement("span");
    t.className = "sb-text";
    t.textContent = p.name;
    b.append(t);
    b.addEventListener("click", () => go("projects"));
    projects.append(b);
  }
  groups.append(workspace, projects);

  const foot = el("sb-foot");
  foot.replaceChildren();
  const settings = sbItem("settings", "Settings", "settings-2");
  settings.addEventListener("click", () => go("settings"));
  const user = document.createElement("button");
  user.type = "button";
  user.className = "sb-user";
  const account = state.baseUrl ? hostOf(state.baseUrl) : "ThreadLink";
  const avatar = document.createElement("span");
  avatar.className = "sb-logo";
  avatar.textContent = (account[0] ?? "T").toUpperCase();
  const names = document.createElement("span");
  names.className = "sb-names";
  const b = document.createElement("b");
  b.textContent = "Signed in";
  const small = document.createElement("small");
  small.textContent = account;
  names.append(b, small);
  const chev = icon("chevrons-up-down");
  chev.classList.add("sb-chevron");
  user.append(avatar, names, chev);
  user.addEventListener("click", () => go("settings"));
  foot.append(settings, user);
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "ThreadLink";
  }
}

function toggleSidebar() {
  sidebar.collapsed = !sidebar.collapsed;
  el("shell").classList.toggle("sidebar-collapsed", sidebar.collapsed);
}

document.addEventListener("keydown", (e) => {
  // Ctrl/Cmd+K: search chats in the sidebar.
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k") {
    const input = el("sb-search");
    if (!input) return;
    e.preventDefault();
    if (sidebar.collapsed) toggleSidebar();
    input.focus();
  }
});

function go(next) {
  // Agents always re-reads the plan from ThreadLink when it is opened.
  if (next === "agents" && section !== "agents") {
    plans.stale = true;
    for (const k of Object.keys(planNote)) delete planNote[k];
    for (const k of Object.keys(planDraft)) delete planDraft[k];
  }
  stopChat();
  section = next;
  changing = null;
  render();
}

// ---------------------------------------------------------------- sign-in

function renderSignIn() {
  view.append(tpl("signin"));
  el("base-url").value = state.baseUrl ?? "";
  el("signin").addEventListener("click", async () => {
    el("signin").disabled = true;
    el("signin").textContent = "Opening your browser…";
    await api.signIn(el("base-url").value.trim());
  });
}

function renderReconnect(why) {
  view.append(tpl("reconnect"));
  el("reconnect-why").textContent = why;
  el("reconnect-url").value = state.baseUrl ?? "";
  el("reconnect").addEventListener("click", async () => {
    el("reconnect").disabled = true;
    el("reconnect").textContent = "Opening your browser…";
    await api.signIn(el("reconnect-url").value.trim());
  });
}

function renderWaiting() {
  view.append(tpl("waiting"));
  el("user-code").textContent = state.pendingSignIn.userCode;
  el("approve-link").addEventListener("click", (e) => {
    e.preventDefault();
    api.openExternal(state.pendingSignIn.url);
  });
  el("cancel-signin").addEventListener("click", () => api.cancelSignIn());
}

// -------------------------------------------------------------------- home

function renderHome() {
  view.append(tpl("home"));
  renderLinkRequests();
  renderSummary(el("home-summary"));
  renderPresence(el("home-presence"));
  renderChatRows(el("home-chat-list"), { limit: HOME_CHATS });
  el("home-chats").addEventListener("click", () => go("chats"));
  el("home-new-chat").addEventListener("click", () => {
    go("chats");
    toggleNewChat(true);
  });
}

/**
 * Presence as three separate things (§4): You (this app's own connection),
 * and this computer as an execution host. Never one for the other.
 */
function renderPresence(node) {
  if (!node) return;
  node.replaceChildren();
  const snap = state.snapshot;
  const working = workOf(state).some((g) => g.running > 0);
  const server = chatList.computer;
  const local =
    snap?.status === "online"
      ? working
        ? "Working"
        : "Online"
      : snap?.status === "paused"
        ? "Paused"
        : snap?.status === "offline"
          ? "Reconnecting"
          : "Starting";
  const hostWord = server?.presence ? PRESENCE_WORD[server.presence] : local;
  for (const [text, tone] of [
    [youText(), you.ok === false ? "warn" : you.ok ? "ready" : "off"],
    [
      `This computer · ${hostWord}`,
      hostWord === "Working" ? "busy" : hostWord === "Online" ? "ready" : "warn",
    ],
  ]) {
    const line = document.createElement("span");
    line.className = "presence";
    const dot = document.createElement("span");
    dot.className = `dot ${tone}`;
    dot.setAttribute("aria-hidden", "true");
    const t = document.createElement("span");
    t.textContent = text;
    line.append(dot, t);
    node.append(line);
  }
}

/** Who can work right now: Team Mode's view if it has one, else the classic providers. */
function agentsOnline(s) {
  const team = s.snapshot?.teamProviders ?? [];
  // A Runtime that probes health is believed over "signed in": status output
  // is not proof that a provider can actually run.
  if (team.some((p) => p && "health" in p))
    return healthOf(s)
      .filter((h) => (h.fresh ? h.fresh === "ready" : h.health === "ready"))
      .map((h) => h.provider);
  if (team.length) return team.filter((p) => p.installed && p.authenticated).map((p) => p.provider);
  return (s.snapshot?.providers ?? []).filter((p) => p.available).map((p) => p.id);
}

/** The Home summary: four numbers a person can take in at a glance. */
function renderSummary(node) {
  if (!node) return;
  node.replaceChildren();
  const online = agentsOnline(state);
  const jobs = teamOf(state);
  const running = workOf(state).reduce((n, g) => n + g.running, 0);
  const waiting = (state.snapshot?.pendingLinks ?? []).length;
  const decisions = jobs.filter((j) => j.verdict === "NEEDS_USER_DECISION").length;
  // A conversation needs you only while its newest line (the feed is newest
  // first) says it is waiting on you.
  const latest = new Map();
  for (const a of activityOf(state))
    if (!latest.has(a.localBindingRef)) latest.set(a.localBindingRef, a);
  const blocked = [...latest.values()].filter((a) => a.event === "task_blocked").length;
  const signIn = healthOf(state).filter((h) => h.health === "needs_sign_in").length;
  const chatsNeedYou = chatList.rows.filter((r) => r.state === "Needs you").length;
  const needs = waiting + decisions + blocked + signIn + chatsNeedYou;
  const host = state.host;

  const tiles = [
    {
      label: "Agents online",
      value: online.length ? online.map(providerName).join(" · ") : "None",
      tone: online.length ? "ready" : "warn",
      go: "agents",
    },
    {
      label: "Execution host",
      value: host?.updateRequired ? "Update needed" : "Online",
      tone: host?.updateRequired ? "warn" : "ready",
      go: "runtime",
    },
    {
      label: "Running on this computer",
      value: String(running),
      tone: running ? "run" : "",
      go: "runtime",
    },
    {
      label: "Needs attention",
      value: needs ? String(needs) : "Nothing",
      tone: needs ? "warn" : "",
      go: decisions || chatsNeedYou ? "chats" : signIn ? "agents" : null,
    },
  ];
  for (const t of tiles) {
    const tile = document.createElement(t.go ? "button" : "div");
    tile.className = `tile${t.tone ? ` ${t.tone}` : ""}`;
    if (t.go) {
      tile.type = "button";
      tile.addEventListener("click", () => go(t.go));
    }
    const value = document.createElement("span");
    value.className = "tile-value";
    value.textContent = t.value;
    const label = document.createElement("span");
    label.className = "tile-label";
    label.textContent = t.label;
    tile.append(value, label);
    node.append(tile);
  }
}

/**
 * Pending link requests. Kept as its own block because it is the one place a
 * request can be answered, and it must appear whether or not the conversation
 * it names is still attached here.
 */
function renderLinkRequests() {
  const links = el("links");
  if (!links) return;
  links.replaceChildren();
  for (const link of state.snapshot?.pendingLinks ?? []) {
    const card = document.createElement("div");
    card.className = "card stack";
    const h = document.createElement("h2");
    h.textContent = "Link request";
    const p = document.createElement("p");
    p.className = "muted small";
    p.textContent = `“${link.from}” wants to use “${link.conversation}”.`;
    const buttons = document.createElement("div");
    buttons.className = "row";
    const approve = document.createElement("button");
    approve.className = "primary";
    approve.textContent = "Approve";
    const decline = document.createElement("button");
    decline.className = "ghost";
    decline.textContent = "Decline";
    const problem = document.createElement("p");
    problem.className = "small danger-text";
    problem.hidden = true;

    // One decision at a time: a second click must not send a second request,
    // and whatever happens the user is told about it.
    const decide = async (approved) => {
      if (decided.has(link.linkId)) return;
      decided.add(link.linkId);
      approve.disabled = true;
      decline.disabled = true;
      problem.hidden = true;
      approve.textContent = approved ? "Approving…" : "Approve";
      decline.textContent = approved ? "Decline" : "Declining…";
      let result;
      try {
        result = await api.decideLink(link.linkId, approved);
      } catch (error) {
        result = { ok: false, error: String(error?.message ?? error) };
      }
      if (result?.ok) {
        // Say so at once; the next snapshot will drop the card entirely.
        h.textContent = approved ? "Linked" : "Declined";
        p.textContent = approved
          ? `“${link.from}” is now linked to “${link.conversation}”.`
          : `Declined the request from “${link.from}”.`;
        buttons.remove();
        return;
      }
      decided.delete(link.linkId);
      approve.disabled = false;
      decline.disabled = false;
      approve.textContent = "Approve";
      decline.textContent = "Decline";
      problem.textContent = result?.error ?? "That did not work. Please try again.";
      problem.hidden = false;
    };

    approve.addEventListener("click", () => void decide(true));
    decline.addEventListener("click", () => void decide(false));
    buttons.append(approve, decline);

    // The conversation this request is for is not attached here any more. The
    // request is still real: explain it, and offer the one step that fixes it.
    if (link.attached === false) {
      const where = link.reattach?.workspaceName;
      p.textContent =
        `“${link.from}” wants to use “${link.conversation}”` +
        `${where ? ` in ${where}` : ""}, which is not attached on this computer.`;
      approve.disabled = true;
      const reattach = document.createElement("button");
      reattach.className = "primary";
      reattach.textContent = "Attach it again";
      reattach.disabled = !link.reattach?.workspacePath;
      reattach.addEventListener("click", async () => {
        reattach.disabled = true;
        reattach.textContent = "Attaching…";
        problem.hidden = true;
        let result;
        try {
          result = await api.attachForLink(link.linkId);
        } catch (error) {
          result = { ok: false, error: String(error?.message ?? error) };
        }
        if (result?.ok) {
          // The next snapshot re-renders this card with Approve enabled.
          reattach.textContent = "Attached";
          return;
        }
        reattach.disabled = false;
        reattach.textContent = "Attach it again";
        problem.textContent = result?.error ?? "That did not work. Please try again.";
        problem.hidden = false;
      });
      buttons.prepend(reattach);
    }

    card.append(h, p, buttons, problem);
    links.append(card);
  }
}

// ----------------------------------------------------------- conversations

const AGENT_TABS = [
  { id: "claude-code", name: "Claude Code" },
  { id: "codex", name: "Codex" },
];

/**
 * Agents: every agent's health at the top, then one section per agent
 * (Agents → Claude Code, Agents → Codex) with its plan, version and models.
 * Everything specific to one provider lives in its own section: for Claude
 * Code that is the background worker / exact conversation / headless session
 * choice, native sessions and the attach flow.
 */
function renderAgents() {
  view.append(tpl("agents"));
  renderHealth(el("agents-health"));
  if (plans.stale && !plans.loading) void loadPlans();
  const tabs = el("agent-tabs");
  const panel = el("agent-panel");
  const found = state.snapshot?.teamProviders ?? [];
  if (!found.length) {
    panel.append(
      empty(
        "ThreadLink has not found Claude Code or Codex on this computer yet. Install one, then restart ThreadLink.",
      ),
    );
  }
  for (const t of AGENT_TABS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "agent-tab";
    const h = healthOf(state).find((x) => x.provider === t.id);
    b.textContent = h ? `${t.name} · ${h.text}` : t.name;
    b.setAttribute("aria-current", t.id === agentTab ? "true" : "false");
    b.addEventListener("click", () => {
      agentTab = t.id;
      for (const other of tabs.children)
        other.setAttribute("aria-current", other === b ? "true" : "false");
      document.getElementById(`agent-${t.id}`)?.scrollIntoView?.({ block: "start" });
    });
    tabs.append(b);

    const sectionNode = document.createElement("section");
    sectionNode.className = "stack agent-section";
    sectionNode.id = `agent-${t.id}`;
    if (found.length) {
      const wrap = document.createElement("div");
      wrap.className = "card stack";
      const h2 = document.createElement("h2");
      h2.textContent = t.name;
      wrap.append(h2, providerCard(t.id));
      sectionNode.append(wrap);
    }
    if (t.id === "claude-code") sectionNode.append(tpl("agent-claude"));
    panel.append(sectionNode);
  }
  renderClaudeConversations();
}

/** Agents → Claude Code: attached conversations and the attach flow (unchanged). */
function renderClaudeConversations() {
  const attached = el("attached");
  attached.replaceChildren();
  const all = (state.snapshot?.workspaces ?? []).flatMap((w) =>
    w.conversations.map((c) => ({ w, c })),
  );
  if (!all.length) {
    attached.append(
      empty("Nothing attached yet. Attach a Claude conversation to start receiving requests."),
    );
  }
  for (const { w, c } of all) attached.append(conversationCard(w, c, true));
  for (const group of detachedActivity(new Set(all.map(({ c }) => c.localBindingRef)))) {
    attached.append(group);
  }
  el("add-more").addEventListener("click", () => {
    selectedWorkspace = null;
    attachMode = "worker";
    go("attach");
  });
}

/**
 * One attached conversation: what it is, how it runs, and what it is doing.
 * Raw identifiers stay out of it; they live under Advanced on the Runtime page.
 */
function conversationCard(workspace, c, withActions) {
  const item = document.createElement("div");
  item.className = "item";
  const body = document.createElement("div");
  body.className = "item-body";
  const title = document.createElement("div");
  title.className = "title";
  title.textContent = c.title;
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = workspace.name;
  const tags = document.createElement("div");
  tags.className = "tags";
  const mode = document.createElement("span");
  mode.className = "badge mode";
  mode.textContent = modeName(c.mode);
  const status = conversationStatus(c);
  const stat = document.createElement("span");
  stat.className = `badge ${status.tone}`;
  stat.textContent = status.label;
  tags.append(mode, stat);
  body.append(title, meta, tags);
  item.append(body);

  if (!withActions) return item;

  const actions = document.createElement("div");
  actions.className = "row";
  const change = document.createElement("button");
  change.className = "ghost small-btn";
  change.type = "button";
  change.textContent = "Change mode";
  change.disabled = c.mode === "fresh";
  change.addEventListener("click", () => {
    changing = changing === c.localBindingRef ? null : c.localBindingRef;
    render();
  });
  const detach = document.createElement("button");
  detach.className = "ghost small-btn";
  detach.type = "button";
  detach.textContent = "Detach";
  detach.addEventListener("click", () => api.detach(workspace.path, c.localBindingRef));
  actions.append(change, detach);
  item.append(actions);

  // The mirror of what has actually happened for this conversation, right
  // under the conversation itself, so it is never in doubt which is which.
  const feed = conversationActivity(c);

  if (changing !== c.localBindingRef) {
    const group = document.createElement("div");
    group.className = "stack tight";
    group.append(item, feed);
    return group;
  }

  // The switch itself: same conversation, same link, different mode.
  const wrapper = document.createElement("div");
  wrapper.className = "card stack";
  const heading = document.createElement("h2");
  heading.textContent = "Change execution mode";
  let picked = c.mode;
  const problem = document.createElement("p");
  problem.className = "small danger-text";
  problem.hidden = true;
  const picker = modePicker(picked, (next) => (picked = next));
  const row = document.createElement("div");
  row.className = "row";
  const confirm = document.createElement("button");
  confirm.className = "primary";
  confirm.type = "button";
  confirm.textContent = "Confirm";
  const cancel = document.createElement("button");
  cancel.className = "ghost";
  cancel.type = "button";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => {
    changing = null;
    render();
  });
  confirm.addEventListener("click", async () => {
    confirm.disabled = true;
    cancel.disabled = true;
    problem.hidden = true;
    confirm.textContent = "Changing…";
    let result;
    try {
      result = await api.setMode(workspace.path, c.localBindingRef, picked);
    } catch (error) {
      result = { ok: false, error: String(error?.message ?? error) };
    }
    if (result?.ok) {
      changing = null;
      render();
      return;
    }
    confirm.disabled = false;
    cancel.disabled = false;
    confirm.textContent = "Confirm";
    problem.textContent = result?.error ?? "That did not work. Please try again.";
    problem.hidden = false;
  });
  row.append(confirm, cancel);
  const note = document.createElement("p");
  note.className = "muted small";
  note.textContent =
    "Your linked chat, this project folder and this computer all stay as they are. " +
    "Your own Claude conversation is not changed.";
  wrapper.append(heading, picker, note, row, problem);

  const group = document.createElement("div");
  group.className = "stack tight";
  group.append(item, feed, wrapper);
  return group;
}

/**
 * The two execution modes bound to a conversation, as a radio group.
 * Background is the default. `unavailable` gives a reason a mode cannot be
 * chosen here (for example, no conversations to use exactly).
 */
function modePicker(current, onChange, unavailable = {}) {
  const claude = (state.snapshot?.providers ?? []).find((p) => p.id === "claude-code");
  const cannot = `${claude?.name ?? "This app"} cannot do this on this computer.`;
  const reasons = {
    worker: claude?.supportsBackgroundWorker === false ? cannot : (unavailable.worker ?? null),
    resume: claude?.supportsExactResume === false ? cannot : (unavailable.resume ?? null),
  };
  const available = { worker: !reasons.worker, resume: !reasons.resume };
  const group = document.createElement("div");
  group.className = "modes";
  const inputs = [];
  for (const id of ["worker", "resume"]) {
    const option = document.createElement("label");
    option.className = `mode-option${id === current ? " chosen" : ""}${
      available[id] ? "" : " unavailable"
    }`;
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "execution-mode";
    input.value = id;
    input.checked = id === current;
    input.disabled = !available[id];
    const name = document.createElement("span");
    name.className = "mode-name";
    name.textContent = MODES[id].name;
    const why = document.createElement("span");
    why.className = "mode-why";
    why.textContent = available[id] ? MODES[id].why : reasons[id];
    option.append(input, name, why);
    input.addEventListener("change", () => {
      for (const [other, node] of inputs) node.classList.toggle("chosen", other === id);
      onChange(id);
    });
    inputs.push([id, option]);
    group.append(option);
  }
  return group;
}

// ------------------------------------------------------------------ attach

async function renderAttach(mine) {
  /** True once a newer render has started: this pass must touch nothing. */
  const superseded = () => mine !== pass;
  view.append(tpl("attach"));
  el("attach-back").addEventListener("click", () => go("agents"));
  const claude = (state.snapshot?.providers ?? []).find((p) => p.id === "claude-code");
  el("claude-detect").textContent = claude?.available
    ? `Detected Claude Code ${claude.version ?? ""}`.trim()
    : "Claude Code was not found. Install it, then restart ThreadLink.";

  const detected = await api.detectedWorkspaces();
  if (superseded()) return;
  const known = (state.snapshot?.workspaces ?? []).map((w) => ({ path: w.path, lastUsedAt: null }));
  const all = [
    ...known,
    ...detected.filter((d) => !known.some((k) => k.path.toLowerCase() === d.path.toLowerCase())),
  ];
  selectedWorkspace = selectedWorkspace ?? all[0]?.path ?? null;

  const list = el("workspace-list");
  list.replaceChildren();
  if (!all.length) list.append(empty("Open Claude Code in a folder, or choose one below."));
  for (const w of all) {
    const item = row(nameOf(w.path), w.lastUsedAt ? `Used ${ago(w.lastUsedAt)}` : w.path, "Choose");
    if (w.path === selectedWorkspace) item.classList.add("selected");
    item.querySelector("button").addEventListener("click", async () => {
      selectedWorkspace = w.path;
      await api.addWorkspace(w.path);
      render();
    });
    list.append(item);
  }
  el("add-workspace").addEventListener("click", async () => {
    const res = await api.addWorkspace();
    if (res?.ok) {
      selectedWorkspace = res.path;
      render();
    }
  });

  if (!selectedWorkspace) return;
  const conversations = await api.listConversations(selectedWorkspace);
  if (superseded()) return;

  // Exact mode needs a conversation to use. With none, say why and do not
  // offer it, rather than let it be chosen and fail later.
  const noExact = exactUnavailable(conversations);
  if (noExact && attachMode === "resume") attachMode = "worker";
  el("conversation-card").hidden = false;
  // Re-render on change: which conversations are worth warning about depends
  // on the mode, and a stale warning is what this whole change is about.
  el("attach-mode").replaceChildren(
    modePicker(
      attachMode,
      (next) => {
        attachMode = next;
        render();
      },
      { resume: noExact },
    ),
  );

  el("conversation-pick").hidden = false;
  el("attach-fresh-why").textContent = MODES.fresh.why;
  const problem = el("attach-problem");
  problem.hidden = true;
  const cl = el("conversation-list");
  cl.replaceChildren();
  if (!conversations.length) {
    cl.append(
      empty(
        "No Claude Code conversations found in this folder yet. Start one in Claude Code, " +
          "or use a new headless session below.",
      ),
    );
  }
  for (const c of conversations) {
    const item = row(
      c.title ?? "Untitled conversation",
      `Used ${ago(c.lastUsedAt)}`,
      c.attached ? "Attached" : "Attach",
      c.busy && attachMode === "resume" ? "Open in Claude Code now" : null,
    );
    const button = item.querySelector("button");
    button.disabled = c.attached;
    button.addEventListener("click", async () => {
      button.disabled = true;
      const result = await api.attach(selectedWorkspace, c.nativeSessionId, c.title, attachMode);
      if (result?.ok === false) {
        button.disabled = false;
        problem.textContent = result.error ?? "That did not work. Please try again.";
        problem.hidden = false;
        return;
      }
      go("agents");
    });
    cl.append(item);
  }
  el("attach-fresh").addEventListener("click", async () => {
    const result = await api.attach(selectedWorkspace, null, null, "worker");
    if (result?.ok === false) {
      problem.textContent = result.error ?? "That did not work. Please try again.";
      problem.hidden = false;
      return;
    }
    go("agents");
  });
}

// ----------------------------------------------------------------- runtime

function renderRuntime() {
  view.append(tpl("runtime"));
  const snap = state.snapshot;
  const paused = state.localPaused || snap?.runtime?.paused;
  const host = state.host ?? {};
  const name = host.label ?? snap?.runtime?.label ?? snap?.identity?.label ?? "This computer";
  el("pc-name").textContent = name;
  kv(el("runtime-kv"), [
    ["Name", name],
    ["Service", youText().replace("You · ", "")],
    ["Computer", host.platform ?? snap?.identity?.platform ?? "—"],
    ["State", paused ? "Paused" : host.online ? "Online" : statusOf(state).title],
    ["Last check-in", snap?.lastHeartbeatAt ? ago(snap.lastHeartbeatAt) : "connecting"],
    ["Start at login", state.settings?.autoStart ? "On" : "Off"],
    ["ThreadLink Runtime", host.version ? `Version ${host.version}` : "—"],
    [
      "Protocol",
      host.protocol === null || host.protocol === undefined ? "—" : String(host.protocol),
    ],
    ["Requests handled", String(snap?.tasksCompleted ?? 0)],
  ]);
  const update = el("update-card");
  update.hidden = !host.updateRequired;
  el("update-text").textContent = host.updateText ?? "";
  el("update-get").addEventListener("click", () => {
    if (state.baseUrl) api.openExternal(`${state.baseUrl}/download`);
    else api.openDashboard();
  });
  const logs = el("open-logs");
  logs.prepend(icon("file-text", 14));
  logs.addEventListener("click", () => api.openLogs?.());
  const pause = el("pause");
  pause.prepend(icon(paused ? "play" : "pause", 14));
  pause.querySelector(".btn-label").textContent = paused ? "Resume" : "Pause";
  pause.addEventListener("click", () => api.setPaused(!paused));
  const restart = el("restart");
  restart.prepend(icon("rotate-ccw", 14));
  restart.addEventListener("click", () => api.restart());

  renderPresence(el("runtime-presence"));
  ensureChatList();
  renderStats(el("runtime-stats"), { paused, host });

  // Work this computer is running for your chats, with honest stages.
  const work = el("runtime-work");
  work.replaceChildren();
  const groups = workOf(state);
  if (!groups.length)
    work.append(
      empty("Nothing running here right now. Work from your chats shows up here while it runs."),
    );
  for (const group of groups) work.append(chatGroup(group));

  el("requests-dashboard").addEventListener("click", () => api.openDashboard());
  // What ran for linked controller conversations (safe fields only).
  el("runtime-requests").replaceChildren(
    activityList(activityOf(state), {
      withConversation: true,
      limit: HOME_FEED_LIMIT,
      emptyText: "No requests yet. When a linked conversation sends one, it shows up here.",
    }),
  );

  // Folder names only: paths stay under Advanced.
  const workspaces = el("workspaces");
  workspaces.replaceChildren();
  if (!(snap?.workspaces ?? []).length) workspaces.append(empty("No project folders yet."));
  for (const w of snap?.workspaces ?? []) {
    const item = document.createElement("div");
    item.className = "item folder-row";
    const glyph = icon("folder");
    glyph.classList.add("row-icon");
    const body = document.createElement("div");
    body.className = "item-body";
    const t = document.createElement("div");
    t.className = "title";
    t.textContent = w.name;
    const m = document.createElement("div");
    m.className = "meta";
    m.textContent = `${w.conversations.length} attached`;
    body.append(t, m);
    item.append(
      glyph,
      body,
      pill(w.exists ? "Linked" : "Folder missing — choose it again", w.exists ? "ok" : "warn"),
    );
    workspaces.append(item);
  }

  copyRows(el("runtime-advanced"), [
    ["ThreadLink address", state.baseUrl],
    ["Computer ID", snap?.runtime?.runtimeId],
    ...(snap?.workspaces ?? []).flatMap((w) => [
      [`${w.name} · folder`, w.path],
      ...w.conversations.flatMap((c) => [
        [`${c.title} · mode`, c.mode],
        [`${c.title} · Claude conversation`, c.nativeSessionId],
        [`${c.title} · background worker`, c.workerNativeSessionId],
      ]),
    ]),
  ]);
}

/** "Up to date" / "Linked" pills. */
function pill(text, tone) {
  const p = document.createElement("span");
  p.className = `pill ${tone}`;
  p.textContent = text;
  return p;
}

/** The three stat cards: Status (ping + beat line), ThreadLink app, Agents here. */
function renderStats(node, { paused, host }) {
  if (!node) return;
  node.replaceChildren();
  const card = (label, iconName) => {
    const c = document.createElement("div");
    c.className = "stat";
    const head = document.createElement("div");
    head.className = "stat-label";
    const l = document.createElement("span");
    l.textContent = label;
    head.append(l, icon(iconName));
    c.append(head);
    return c;
  };
  const running = workOf(state).reduce((n, g) => n + g.running, 0);
  const tone = statusOf(state).tone;
  const word = paused
    ? "Paused"
    : running
      ? "Working"
      : state.snapshot?.status === "online"
        ? "Online"
        : state.snapshot?.status === "offline"
          ? "Reconnecting"
          : "Starting";
  const status = card("Status", "activity");
  const value = document.createElement("div");
  value.className = "stat-value";
  const dot = document.createElement("span");
  dot.className = `ping ${running ? "run" : (PING_TONE[tone] ?? "off")}`;
  const w = document.createElement("span");
  w.textContent = word;
  value.append(dot, w);
  const note = document.createElement("div");
  note.className = "stat-note";
  note.textContent = `${running ? `${running} running` : "Nothing running"} · ${
    state.snapshot?.lastHeartbeatAt ? `seen ${ago(state.snapshot.lastHeartbeatAt)}` : "connecting"
  }`;
  status.append(value, note);
  if (running) {
    const beat = document.createElement("div");
    beat.className = "beat";
    beat.setAttribute("aria-hidden", "true");
    status.append(beat);
  }

  const app = card("ThreadLink app", "shield-check");
  const v = document.createElement("div");
  v.className = "stat-value";
  v.textContent = host.version ?? "—";
  const n2 = document.createElement("div");
  n2.className = "stat-note";
  n2.append(
    pill(host.updateRequired ? "Update needed" : "Up to date", host.updateRequired ? "warn" : "ok"),
    document.createTextNode(
      host.protocol === null || host.protocol === undefined ? "" : ` protocol ${host.protocol}`,
    ),
  );
  app.append(v, n2);

  const agents = card("Agents here", "bot");
  const views = healthOf(state);
  const ready = views.filter((h) => h.fresh === "ready" || (!h.fresh && h.health === "ready"));
  const row = document.createElement("div");
  row.className = "stat-value";
  for (const h of views) {
    const a = document.createElement("span");
    a.className = `agent-chip${ready.includes(h) ? "" : " dim"}`;
    a.dataset.provider = h.provider;
    a.textContent = h.provider === "codex" ? "X" : "C";
    a.title = h.line;
    row.append(a);
  }
  const count = document.createElement("span");
  count.textContent = `${ready.length} of ${views.length} ready`;
  row.append(count);
  agents.append(row);
  const exhausted = views.find((h) => h.health === "usage_exhausted");
  const problem = exhausted ?? views.find((h) => h.tone === "fail");
  const n3 = document.createElement("div");
  n3.className = `stat-note${problem ? " warn" : ""}`;
  n3.textContent = problem
    ? `${problem.line}${exhausted?.resetsAt ? ` · resets ${resetText(exhausted.resetsAt)}` : ""}`
    : "All agents ready";
  agents.append(n3);
  node.append(status, app, agents);
}

// ----------------------------------------------------- notifications, settings

function renderNotifications() {
  view.append(tpl("notifications"));
  el("set-notifications").checked = state.settings.notifications;
  el("set-notifications").addEventListener("change", (e) =>
    api.setSettings({ notifications: e.target.checked }),
  );
  ensureChatList();
  const needs = el("needs-you");
  needs.replaceChildren();
  const links = state.snapshot?.pendingLinks?.length ?? 0;
  if (links) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "item chat-row";
    b.textContent = `${links} link request${links === 1 ? "" : "s"} waiting for you on Home`;
    b.addEventListener("click", () => go("home"));
    needs.append(b);
  }
  for (const r of chatList.needsYou) needs.append(chatRowNode(r));
  if (!needs.children.length) needs.append(empty("Nothing needs you right now."));
  const unread = el("unread-chats");
  unread.replaceChildren();
  const rows = chatList.rows.filter((r) => r.unread && r.state !== "Needs you");
  for (const r of rows.slice(0, 20)) unread.append(chatRowNode(r));
  if (!rows.length) unread.append(empty("You are all caught up."));
}

// ---------------------------------------------------------------- projects

function renderProjects() {
  view.append(tpl("projects"));
  ensureChatList();
  const list = el("project-list");
  list.replaceChildren();
  if (!chatList.projects.length) {
    list.append(
      empty(
        chatList.loadedAt
          ? "No projects yet. Create one in ThreadLink on the web, then run it on this computer."
          : "Loading your projects…",
      ),
    );
    return;
  }
  for (const p of chatList.projects) {
    const card = document.createElement("section");
    card.className = "card stack project";
    const head = document.createElement("div");
    head.className = "card-head";
    const h = document.createElement("h2");
    h.textContent = p.name;
    head.append(h);
    if (p.runsOn) head.append(badge(`Runs on ${p.runsOn}`, p.thisComputer ? "ready" : "mode"));
    card.append(head);
    const chats = document.createElement("div");
    chats.className = "stack tight";
    for (const r of p.chats) chats.append(chatRowNode(r));
    if (!p.chats.length) chats.append(empty("No chats in this project yet."));
    card.append(chats);
    list.append(card);
  }
}

/** A segmented radio group (built with DOM APIs, one change per click). */
function segmented(node, name, options, value, onChange) {
  node.replaceChildren();
  for (const [v, label] of options) {
    const l = document.createElement("label");
    const input = document.createElement("input");
    input.type = "radio";
    input.name = name;
    input.value = v;
    input.checked = v === value;
    input.addEventListener("change", () => onChange(v));
    const t = document.createElement("span");
    t.textContent = label;
    l.append(input, t);
    node.append(l);
  }
}

function renderAppearance() {
  const s = state.settings ?? {};
  segmented(
    el("set-theme"),
    "theme",
    [
      ["system", "System"],
      ["light", "Light"],
      ["dark", "Dark"],
    ],
    THEMES.includes(s.theme) ? s.theme : "system",
    (theme) => setAppearance({ theme }),
  );
  segmented(
    el("set-backdrop"),
    "backdrop",
    [
      ["aurora", "Aurora"],
      ["dusk", "Dusk"],
      ["grid", "Grid"],
      ["none", "Plain"],
    ],
    BACKDROPS.includes(s.backdrop) ? s.backdrop : "dusk",
    (backdrop) => setAppearance({ backdrop }),
  );
  const animate = el("set-animate");
  animate.checked = s.animate !== false;
  animate.addEventListener("change", () => setAppearance({ animate: animate.checked }));
}

function renderSettings() {
  view.append(tpl("settings"));
  renderAppearance();
  el("set-autostart").checked = state.settings.autoStart;
  el("set-autostart").addEventListener("change", (e) =>
    api.setSettings({ autoStart: e.target.checked }),
  );
  el("settings-agents").addEventListener("click", () => go("agents"));
  el("plan-dashboard").addEventListener("click", () => api.openDashboard());
  renderFailover(el("failover"));
  el("mcp-url").textContent = `${state.baseUrl}/mcp`;
  bindCopy(el("copy-mcp"), () => `${state.baseUrl}/mcp`);
  copyRows(el("settings-advanced"), [
    ["ThreadLink address", state.baseUrl],
    ["Connector URL", state.baseUrl ? `${state.baseUrl}/mcp` : null],
    ["This computer", state.snapshot?.identity?.kind],
  ]);
  el("signout").addEventListener("click", () => api.signOut());
}

/** The failover choice being saved, and what the last save said. */
const failoverSave = { busy: false, note: null };

/**
 * When an agent's included usage runs out (§5). Editable here when the
 * server offers the runtime settings route; otherwise shown, and changed on
 * the web settings page.
 */
function renderFailover(node) {
  if (!node) return;
  ensureChatList();
  node.replaceChildren();
  const f = chatList.failover;
  const editable = f?.editable === true && typeof api.setFailover === "function";
  const options = f?.options ?? [
    { value: "auto", label: "Continue with another included agent (default)", chosen: false },
    { value: "ask", label: "Ask me first", chosen: false },
    { value: "wait", label: "Wait for the same agent", chosen: false },
  ];
  const list = document.createElement("div");
  list.className = "modes failover-options";
  list.setAttribute("role", "radiogroup");
  for (const o of options) {
    const row = document.createElement("label");
    row.className = `mode-option${o.chosen ? " chosen" : ""}`;
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "failover";
    input.value = o.value;
    input.checked = o.chosen;
    input.disabled = !editable || failoverSave.busy;
    input.addEventListener("change", () => void saveFailover(o.value));
    const name = document.createElement("span");
    name.className = "mode-name";
    name.textContent = o.label;
    row.append(input, name);
    list.append(row);
  }
  node.append(list);
  if (failoverSave.note) {
    const note = document.createElement("p");
    note.className = `small failover-note ${failoverSave.note.ok ? "ok-text" : "danger-text"}`;
    note.setAttribute("role", "status");
    note.textContent = failoverSave.note.text;
    node.append(note);
  }
  if (editable) return;
  const why = document.createElement("p");
  why.className = "muted small";
  why.textContent = "Change in ThreadLink web settings.";
  const open = document.createElement("button");
  open.type = "button";
  open.className = "ghost small-btn";
  open.id = "failover-web";
  open.textContent = "Change in ThreadLink web settings";
  open.addEventListener("click", () => {
    if (state.baseUrl) api.openExternal(`${state.baseUrl}/dashboard/settings`);
    else api.openDashboard();
  });
  node.append(why, open);
}

async function saveFailover(value) {
  if (failoverSave.busy) return;
  failoverSave.busy = true;
  failoverSave.note = null;
  let res = null;
  try {
    res = await api.setFailover(value);
  } catch {
    res = null;
  }
  noteRequest(res);
  failoverSave.busy = false;
  // Whatever happened, show what ThreadLink now holds, never the request.
  if (res?.ok && res.failover) {
    chatList.failover = res.failover;
    failoverSave.note = { ok: true, text: "Saved" };
  } else {
    failoverSave.note = { ok: false, text: "Couldn't save — nothing changed" };
    chatList.loadedAt = 0;
    void loadChatList();
  }
  if (section === "settings") render();
}

// -------------------------------------------------------- providers & plans

const PROVIDER_NAMES = { "claude-code": "Claude Code", codex: "Codex" };
const providerName = (id) => PROVIDER_NAMES[id] ?? "Another agent";

const PLAN_SAVE_FAILED = "Couldn't save your plan — nothing changed";

// ----------------------------------------------------------- provider health

/**
 * Health as main derived it from the Runtime's probe (fixed words only). With
 * no view at all, every provider is "Not checked yet": never Ready by default.
 */
const HEALTH_FALLBACK = [
  { provider: "claude-code", providerName: "Claude Code", health: "unknown" },
  { provider: "codex", providerName: "Codex", health: "unknown" },
].map((h) => ({
  ...h,
  text: "Not checked yet",
  line: `${h.providerName} — Not checked yet`,
  tone: "wait",
  checkedAt: null,
  instruction: null,
}));
const healthOf = (s) => (Array.isArray(s?.health) && s.health.length ? s.health : HEALTH_FALLBACK);

/** "Check again" is allowed once per 30 s here, and again in main. */
const CHECK_MS = 30_000;
const check = { at: 0, busy: false, note: null, timer: null };

const CHECK_NOTES = {
  ok: "Checked just now.",
  "too-soon": "Checked a moment ago. Try again in a little while.",
  unavailable: "This computer's ThreadLink can't check right now. Restart ThreadLink to check.",
  failed: "Couldn't check right now. Try again in a moment.",
  invalid: "Couldn't check right now. Try again in a moment.",
};

async function checkAgain(button) {
  if (check.busy || Date.now() - check.at < CHECK_MS) return;
  check.busy = true;
  check.at = Date.now();
  check.note = null;
  button.disabled = true;
  button.textContent = "Checking…";
  let result = null;
  try {
    result = await api.checkProviders();
  } catch {
    result = null;
  }
  check.busy = false;
  // Only fixed words: whatever the probe printed never reaches the page.
  check.note = result?.ok ? CHECK_NOTES.ok : (CHECK_NOTES[result?.error] ?? CHECK_NOTES.failed);
  clearTimeout(check.timer);
  check.timer = setTimeout(() => {
    check.timer = null;
    render();
  }, CHECK_MS);
  render();
}

/** The "Check again" button with its note, sharing one cool-down everywhere. */
function checkAgainRow() {
  const row = document.createElement("div");
  row.className = "row health-check";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ghost small-btn check-again";
  const cooling = Date.now() - check.at < CHECK_MS;
  button.textContent = check.busy ? "Checking…" : "Check again";
  button.disabled = check.busy || cooling;
  button.addEventListener("click", () => void checkAgain(button));
  row.append(button);
  if (check.note) {
    const note = document.createElement("span");
    note.className = "muted small check-note";
    note.setAttribute("role", "status");
    note.textContent = check.note;
    row.append(note);
  }
  return row;
}

/** One provider's health: "Claude Code — Needs sign-in", and what to do about it. */
function healthLine(h) {
  const line = document.createElement("div");
  line.className = `health ${h.tone}`;
  line.dataset.health = h.health;
  line.dataset.fresh = h.fresh ?? "";
  line.addEventListener("click", () => {
    if (section !== "agents") return;
    agentTab = h.provider;
    document.getElementById(`agent-${h.provider}`)?.scrollIntoView?.({ block: "start" });
  });
  const head = document.createElement("div");
  head.className = "health-head";
  const dot = document.createElement("span");
  dot.className = `dot ${h.tone === "ready" ? "ready" : h.tone === "fail" ? "off" : "busy"}`;
  dot.setAttribute("aria-hidden", "true");
  const text = document.createElement("span");
  text.className = "health-line";
  text.textContent = h.line;
  head.append(dot, text);
  // Freshness comes from main's single calculation: never "Ready" beside
  // stale words, and never recomputed here.
  if (h.when) {
    const when = document.createElement("span");
    when.className = "muted small health-when";
    when.textContent = h.when;
    head.append(when);
  }
  line.append(head);
  if (h.instruction) {
    const how = document.createElement("p");
    how.className = "small health-instruction";
    how.textContent = h.instruction;
    line.append(how);
  }
  // Only when the provider reported it (§5): never an invented reset time.
  if (h.health === "usage_exhausted" && h.resetsAt) {
    const when = document.createElement("p");
    when.className = "small muted health-resets";
    when.textContent = `Resets ${resetText(h.resetsAt)}`;
    line.append(when);
  }
  return line;
}

function resetText(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? `at ${clock(iso)}`
    : `${d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })} at ${clock(iso)}`;
}

/** Every provider's health, with one "Check again" for all of them. */
function renderHealth(node) {
  if (!node) return;
  node.replaceChildren();
  for (const h of healthOf(state)) node.append(healthLine(h));
  node.append(checkAgainRow());
}

/** Asks the main process (and so the server) for the declared plans. */
async function loadPlans() {
  plans.loading = true;
  plans.stale = false;
  let result = null;
  try {
    result = await api.getPlans();
  } catch {
    result = null;
  }
  plans.loading = false;
  if (result?.ok && Array.isArray(result.providers)) {
    plans.views = result.providers;
    plans.fromCache = result.stale === true;
    plans.failed = false;
  } else {
    plans.failed = true;
  }
  if (section === "agents") render();
}

/** Where usage policy and paid usage are changed: the web dashboard only. */
function openProviderSettings() {
  if (state.baseUrl) api.openExternal(`${state.baseUrl}/dashboard/settings/providers`);
  else api.openDashboard();
}

/**
 * "Your plan" (declared, from ThreadLink) beside "Provider reported" (what
 * this computer's CLI said), and the one thing the desktop may change: the
 * declared plan. Usage policy and paid usage are shown, not edited.
 */
function planBlock(provider) {
  const box = document.createElement("div");
  box.className = "plan";
  const view = (plans.views ?? []).find((v) => v.provider === provider);
  if (!view) {
    const p = document.createElement("p");
    p.className = `small ${plans.failed ? "danger-text" : "muted"}`;
    p.textContent = plans.failed
      ? "Couldn't load your plan from ThreadLink. Try again later, or change it in the browser."
      : "Loading your plan…";
    box.append(p);
    return box;
  }

  const facts = document.createElement("div");
  facts.className = "kv";
  kvAppend(facts, "Your plan", view.yourPlan);
  kvAppend(facts, "Provider reported", view.reported);
  kvAppend(facts, "Usage policy", view.usagePolicy);
  kvAppend(facts, "Paid usage", view.paidUsage);
  if (view.notSet) facts.querySelector(".v")?.classList.add("warn-text");

  const edit = document.createElement("div");
  edit.className = "plan-edit";
  const label = document.createElement("label");
  label.className = "field plan-field";
  const caption = document.createElement("span");
  caption.textContent = "Choose your plan";
  const select = document.createElement("select");
  select.name = `plan-${provider}`;
  for (const o of view.options) {
    const option = document.createElement("option");
    option.value = o.value;
    option.textContent = o.label;
    select.append(option);
  }
  select.value = planDraft[provider] ?? view.declared;
  label.append(caption, select);

  const save = document.createElement("button");
  save.type = "button";
  save.className = "primary small-btn plan-save";
  const saving = planSaving.has(provider);
  save.textContent = saving ? "Saving…" : "Save";
  save.disabled = saving || select.value === view.declared;

  const note = document.createElement("p");
  note.className = "small plan-note";
  note.setAttribute("role", "status");
  const said = planNote[provider];
  note.hidden = !said;
  if (said) {
    note.textContent = said.text;
    note.classList.add(said.tone === "ok" ? "ok-text" : "danger-text");
  }

  select.addEventListener("change", () => {
    planDraft[provider] = select.value;
    delete planNote[provider];
    note.hidden = true;
    save.disabled = planSaving.has(provider) || select.value === view.declared;
  });

  save.addEventListener("click", async () => {
    if (planSaving.has(provider)) return;
    const chosen = select.value;
    planSaving.add(provider);
    save.disabled = true;
    save.textContent = "Saving…";
    note.hidden = true;
    let result = null;
    try {
      result = await api.setPlan(provider, chosen);
    } catch {
      result = null;
    }
    planSaving.delete(provider);
    delete planDraft[provider];
    // Whatever happened, show what the server now holds, never the request.
    if (Array.isArray(result?.providers)) {
      plans.views = result.providers;
      plans.fromCache = false;
    } else {
      plans.stale = true;
    }
    planNote[provider] = result?.ok
      ? { text: "Saved", tone: "ok" }
      : { text: PLAN_SAVE_FAILED, tone: "fail" };
    render();
  });

  edit.append(label, save);

  const web = document.createElement("div");
  web.className = "plan-web";
  const why = document.createElement("span");
  why.className = "muted small";
  why.textContent = "Usage policy and paid usage are changed in the browser.";
  const open = document.createElement("button");
  open.type = "button";
  open.className = "ghost small-btn";
  open.textContent = "Change in browser";
  open.addEventListener("click", () => openProviderSettings());
  web.append(why, open);

  box.append(facts, edit, note, web);
  return box;
}

/** Agents → <provider>: health, plan, version and models for one agent. */
function providerCard(provider) {
  const node = document.createElement("div");
  node.className = "stack";
  const p = (state.snapshot?.teamProviders ?? []).find((x) => x.provider === provider);
  if (!p) {
    node.append(
      empty(
        `ThreadLink has not found ${providerName(provider)} on this computer yet. Install it, then restart ThreadLink.`,
      ),
    );
    return node;
  }
  if (plans.fromCache && plans.views) {
    const stale = document.createElement("p");
    stale.className = "muted small";
    stale.textContent = "Showing the plan ThreadLink last sent. It couldn't be refreshed just now.";
    node.append(stale);
  }
  {
    const card = document.createElement("div");
    card.className = "provider";

    const head = document.createElement("div");
    head.className = "provider-head";
    const name = document.createElement("div");
    name.className = "title";
    name.textContent = providerName(p.provider);
    const tags = document.createElement("div");
    tags.className = "tags";
    // Health from the Runtime's probe, not "signed in" from a status command.
    const health = healthOf(state).find((h) => h.provider === p.provider);
    tags.append(
      badge(p.installed ? "Installed" : "Not installed", p.installed ? "ready" : "fail"),
      badge(health?.status ?? health?.text ?? "Not checked yet", health?.tone ?? "wait"),
    );
    head.append(name, tags);

    const facts = document.createElement("div");
    facts.className = "kv";
    kvAppend(facts, "Version", p.version ?? "Not reported");
    kvAppend(facts, "Remaining usage", `not reported by ${providerName(p.provider)}`);

    const models = document.createElement("div");
    models.className = "models";
    const label = document.createElement("span");
    label.className = "models-label";
    label.textContent = "Models";
    models.append(label);
    if (!p.models?.length) {
      const none = document.createElement("span");
      none.className = "muted small";
      none.textContent = "None reported";
      models.append(none);
    }
    for (const m of p.models ?? []) models.append(badge(m.displayName, "model"));

    card.append(head);
    if (health?.instruction) {
      const how = document.createElement("p");
      how.className = "small health-instruction";
      how.textContent = health.instruction;
      card.append(how);
    }
    card.append(planBlock(p.provider), facts, models);
    const tech = techDetails([
      ["Version", p.version],
      ["Detail", p.detail],
    ]);
    if (tech) card.append(tech);
    node.append(card);
  }
  return node;
}

// ------------------------------------------------------------------- chats

const teamOf = (s) => s.snapshot?.team ?? [];
/** Running and recent work, grouped by chat by main (honest stages included). */
const workOf = (s) => (Array.isArray(s?.work) ? s.work : []);

/** Each final verdict, in plain words. */
const VERDICTS = {
  PASS: { label: "Done — passed final review", tone: "ready" },
  NEEDS_FIX: { label: "Needs fixes", tone: "wait" },
  BLOCKED: { label: "Blocked", tone: "fail" },
  NEEDS_USER_DECISION: { label: "Needs your decision", tone: "wait" },
};

/** What a job is doing overall, when it has no verdict yet. */
const JOB_PHASES = {
  queued: "Waiting to start",
  normalising: "Understanding the request",
  planning: "Planning",
  building: "Building",
  reviewing: "Reviewing",
  integrating: "Putting it together",
  inspecting: "Final review",
  failed: "Stopped — it did not finish",
  cancelled: "Cancelled",
};

/** How a chat runs its work, in the words the web uses. */
const JOB_MODES = { solo: "Solo", pair: "Builder + Reviewer", team: "Team" };

/** The five states a step can be in, and how each one looks. */
const STEP = {
  done: { sym: "✓", label: "Done" },
  active: { sym: "●", label: "In progress" },
  waiting: { sym: "○", label: "Not started" },
  failed: { sym: "✕", label: "Stopped here" },
  skipped: { sym: "–", label: "Skipped" },
};

const UNIT_STEP = {
  pending: "waiting",
  ready: "waiting",
  running: "active",
  in_review: "active",
  changes_requested: "active",
  approved: "done",
  integrated: "done",
  failed: "failed",
  skipped: "skipped",
};

/** One chat (or, for older work with no chat, one room) and its jobs. */
function chatGroup(group) {
  const card = document.createElement("section");
  card.className = "card stack chat-group";
  const head = document.createElement("div");
  head.className = "card-head";
  const h = document.createElement("h2");
  h.className = "chat-name";
  h.textContent = String(group.name ?? "Chat");
  const glyph = icon(group.running ? "wrench" : "messages-square");
  glyph.classList.add("row-icon", group.running ? "accent" : "plain");
  const left = document.createElement("div");
  left.className = "row";
  left.append(glyph, h);
  head.append(left);
  const right = document.createElement("div");
  right.className = "row";
  if (group.running) right.append(badge(`${group.running} running`, "run"));
  const chatId =
    typeof group.key === "string" && group.key.startsWith("chat:") ? group.key.slice(5) : null;
  if (chatId && /^tlcht_[0-9a-f]{32}$/.test(chatId)) {
    const open = document.createElement("button");
    open.type = "button";
    open.className = "ghost small-btn";
    open.textContent = "Open chat";
    open.addEventListener("click", () => openChat(chatId));
    right.append(open);
  }
  head.append(right);
  card.append(head);
  for (const job of group.jobs ?? []) card.append(teamJob(job));
  return card;
}

function teamJob(job) {
  const card = document.createElement("article");
  card.className = "stack team-job";

  const head = document.createElement("div");
  head.className = "card-head";
  const goal = document.createElement("p");
  goal.className = "team-goal";
  goal.textContent = job.goal;
  const verdict = VERDICTS[job.verdict];
  const running = job.running === true;
  const tags = document.createElement("div");
  tags.className = "tags";
  if (JOB_MODES[job.mode]) tags.append(badge(JOB_MODES[job.mode], "mode"));
  tags.append(
    verdict
      ? badge(verdict.label, verdict.tone)
      : badge(
          running ? "Running" : (JOB_PHASES[job.status] ?? "Finished"),
          running ? "run" : "lost",
        ),
  );
  head.append(goal, tags);
  card.append(head);

  if (running) {
    const agents = document.createElement("div");
    agents.className = "team-agents";
    const doing = new Map((job.agents ?? []).map((a) => [a.provider, a.doing]));
    const involved = new Set([
      ...doing.keys(),
      ...(job.units ?? []).flatMap((u) => [u.owner, u.reviewer].filter(Boolean)),
    ]);
    for (const provider of involved) {
      const line = document.createElement("div");
      line.className = `team-agent${doing.has(provider) ? " busy" : ""}`;
      const who = document.createElement("span");
      who.className = "team-agent-name";
      who.textContent = providerName(provider);
      const what = document.createElement("span");
      what.className = "team-agent-doing";
      what.textContent = doing.get(provider) ?? "Waiting";
      line.append(who, document.createTextNode(" — "), what);
      agents.append(line);
    }
    if (!involved.size) {
      const line = document.createElement("div");
      line.className = "team-agent";
      line.textContent = job.line || JOB_PHASES[job.status] || "Working";
      agents.append(line);
    }
    card.append(agents);
  }

  const round = document.createElement("p");
  round.className = "team-round";
  const findings =
    job.openFindings === 1
      ? "1 finding remaining"
      : job.openFindings
        ? `${job.openFindings} findings remaining`
        : "No findings open";
  round.textContent = job.reviewRound
    ? `Review round ${job.reviewRound} / ${job.maxReviewRounds} · ${findings}`
    : `No review round yet · ${findings}`;
  card.append(round, teamSteps(job));

  if (verdict) {
    const final = document.createElement("div");
    final.className = `team-verdict ${verdict.tone}`;
    final.textContent = verdict.label;
    card.append(final);
  } else if (!running) {
    const final = document.createElement("div");
    final.className = "team-verdict fail";
    final.textContent = JOB_PHASES[job.status] ?? "Finished";
    card.append(final);
  }

  // Why it stopped, from the verdict reason: "Claude Code needs you to sign in
  // again on this computer." rather than a vague "an agent failed".
  if (job.stop?.text) {
    const why = document.createElement("p");
    why.className = `small team-stop${job.stop.needsSignIn ? " sign-in" : ""}`;
    why.textContent = job.stop.text;
    card.append(why);
    if (job.stop.instruction) {
      const how = document.createElement("p");
      how.className = "small muted team-stop-how";
      how.textContent = job.stop.instruction;
      const open = document.createElement("button");
      open.type = "button";
      open.className = "ghost small-btn";
      open.textContent = "Check agents";
      open.addEventListener("click", () => go("agents"));
      card.append(how, open);
    }
  }
  return card;
}

/** The unit lines that sit under Build, without graph jargon. */
function unitSteps(job) {
  return (job.units ?? []).map((u, i, all) => {
    const state = UNIT_STEP[u.status] ?? "waiting";
    const owner = providerName(u.owner);
    // A solo unit has no reviewer: never claim one reviewed it.
    const reviewer = u.reviewer ? providerName(u.reviewer) : null;
    const who = {
      done: reviewer
        ? `${owner}, reviewed by ${reviewer}`
        : `${owner}, built it (no review in solo mode)`,
      failed: `${owner}, did not finish`,
      skipped: `${owner}, skipped`,
      waiting: `${owner}, waiting`,
      active:
        reviewer && u.status === "in_review"
          ? `${owner}, being reviewed by ${reviewer}`
          : reviewer && u.status === "changes_requested"
            ? `${owner}, fixing review notes from ${reviewer}`
            : owner,
    }[state];
    return {
      state,
      text: `${u.title} — ${who}`,
      branch: i === all.length - 1 ? "└─" : "├─",
      unit: true,
    };
  });
}

/**
 * Understanding request · Plan · Build (with its units) · Review · Integration.
 * The stages come from main (the Runtime's own, or an honest derivation); a
 * stage never shows ✓ here unless main said so.
 */
function teamSteps(job) {
  const stages = Array.isArray(job.stages) ? job.stages : [];
  const steps = [];
  for (const stage of stages) {
    const known = STEP[stage.state] ? stage.state : "waiting";
    steps.push({ state: known, text: String(stage.label ?? ""), branch: "", key: stage.key });
    if (stage.key === "build") steps.push(...unitSteps(job));
  }

  const list = document.createElement("ol");
  list.className = "steps";
  list.setAttribute("aria-label", "Progress");
  for (const s of steps) {
    const item = document.createElement("li");
    item.className = `step ${s.state}${s.unit ? " unit" : " stage"}`;
    item.dataset.state = s.state;
    if (s.key) item.dataset.stage = s.key;
    if (s.branch) {
      const branch = document.createElement("span");
      branch.className = "branch";
      branch.setAttribute("aria-hidden", "true");
      branch.textContent = s.branch;
      item.append(branch);
    }
    const sym = document.createElement("span");
    sym.className = "sym";
    sym.textContent = STEP[s.state].sym;
    sym.title = STEP[s.state].label;
    sym.setAttribute("aria-label", STEP[s.state].label);
    const text = document.createElement("span");
    text.className = "step-text";
    text.textContent = s.text;
    item.append(sym, text);
    list.append(item);
  }
  return list;
}

// ---------------------------------------------------------------- activity

/**
 * The mirrored activity feed.
 *
 * A background worker runs in a Claude conversation the user cannot see, and
 * there is no supported way to write into the one they do have open. So the
 * milestones are mirrored here, under the conversation they belong to. Only
 * the safe fields of an entry are ever shown: never the prompt, the result,
 * a raw error, or any identifier.
 */

/** What each mirrored event is called, and the badge it wears. */
const EVENTS = {
  task_started: { label: "Task started", tone: "run" },
  task_completed: { label: "Task completed", tone: "ready" },
  task_failed: { label: "Task failed", tone: "fail" },
  task_blocked: { label: "Needs you", tone: "wait" },
  task_lost: { label: "Task interrupted", tone: "lost" },
};

/** What each blocked state means to the person waiting on it. */
const BLOCKED = {
  plan_mode: "Claude is in Plan Mode, so it will not make changes.",
  approval_required: "Claude needs your permission to continue.",
  user_input_required: "Claude is waiting for an answer from you.",
};

/** Where a started task is running, in the user's words. */
const RUNNING_IN = {
  worker: "Running in background worker",
  resume: "Running in your linked Claude conversation",
  fresh: "Running in a new headless session",
};

/** How many lines one conversation shows before the dashboard takes over. */
const FEED_LIMIT = 6;
/** Home keeps it shorter still: a glance, not a feed. */
const HOME_FEED_LIMIT = 4;

const activityOf = (s) => s.snapshot?.activity ?? [];

/** The single plain line under a mirrored event. Safe fields only. */
function activityLine(entry) {
  if (entry.event === "task_started") return RUNNING_IN[entry.mode] ?? "Running in Claude Code";
  if (entry.event === "task_completed")
    return entry.summary ?? "Finished. Open the dashboard for the full result.";
  if (entry.event === "task_blocked")
    return BLOCKED[entry.blocked] ?? entry.detail ?? "Waiting before it can carry on.";
  if (entry.event === "task_failed")
    return entry.detail ?? "It did not finish. Open the dashboard for the details.";
  return entry.detail ?? "It stopped before finishing. Send it again when you are ready.";
}

/** One mirrored line. `withConversation` attributes it where the feed is mixed. */
function activityItem(entry, withConversation) {
  const node = document.createElement("div");
  node.className = "activity-item";

  const head = document.createElement("div");
  head.className = "activity-top";
  const event = EVENTS[entry.event] ?? { label: "Update", tone: "" };
  const badge = document.createElement("span");
  badge.className = `badge ${event.tone}`.trim();
  badge.textContent = event.label;
  const when = document.createElement("span");
  when.className = "activity-when";
  when.textContent = ago(entry.at);
  head.append(badge, when);

  const title = document.createElement("div");
  title.className = "title";
  title.textContent = entry.title;

  const line = document.createElement("div");
  line.className = "activity-said";
  line.textContent = activityLine(entry);

  node.append(head, title, line);

  if (withConversation) {
    const where = document.createElement("div");
    where.className = "meta";
    where.textContent = `in ${entry.conversation}`;
    node.append(where);
  }
  return node;
}

/** A list of mirrored lines, newest first, with something useful when empty. */
function activityList(entries, { withConversation = false, emptyText, limit = FEED_LIMIT } = {}) {
  const list = document.createElement("div");
  list.className = "activity-list";
  if (!entries.length) {
    list.append(empty(emptyText));
    return list;
  }
  for (const entry of entries.slice(0, limit)) {
    list.append(activityItem(entry, withConversation));
  }
  return list;
}

/** The feed for one attached conversation, with a way to see the full detail. */
function conversationActivity(c) {
  const mine = activityOf(state).filter((e) => e.localBindingRef === c.localBindingRef);
  const panel = document.createElement("div");
  panel.className = "activity";
  const head = document.createElement("div");
  head.className = "activity-head";
  const heading = document.createElement("span");
  heading.className = "activity-heading";
  heading.textContent = "Activity";
  head.append(heading);
  if (mine.length) {
    const open = document.createElement("button");
    open.className = "ghost small-btn";
    open.type = "button";
    open.textContent = "Open dashboard";
    open.addEventListener("click", () => api.openDashboard());
    head.append(open);
  }
  panel.append(
    head,
    activityList(mine, {
      emptyText:
        "Nothing has run here yet. Send a task from your controller (for example ChatGPT) " +
        "and it will show up here.",
    }),
  );
  return panel;
}

/**
 * Mirrored lines whose conversation is no longer attached on this computer.
 * They still happened, so they are kept — just plainly marked as past.
 */
function detachedActivity(attachedRefs) {
  const groups = new Map();
  for (const entry of activityOf(state)) {
    if (attachedRefs.has(entry.localBindingRef)) continue;
    const group = groups.get(entry.localBindingRef) ?? { name: entry.conversation, entries: [] };
    group.entries.push(entry);
    groups.set(entry.localBindingRef, group);
  }
  return [...groups.values()].map((group) => {
    const wrapper = document.createElement("div");
    wrapper.className = "stack tight";
    const item = document.createElement("div");
    item.className = "item";
    const body = document.createElement("div");
    body.className = "item-body";
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = group.name;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = "No longer attached on this computer";
    body.append(title, meta);
    item.append(body);
    const panel = document.createElement("div");
    panel.className = "activity";
    const head = document.createElement("div");
    head.className = "activity-head";
    const heading = document.createElement("span");
    heading.className = "activity-heading";
    heading.textContent = "Earlier activity";
    head.append(heading);
    panel.append(head, activityList(group.entries));
    wrapper.append(item, panel);
    return wrapper;
  });
}

// ------------------------------------------------------------ chats (0.11)

/**
 * Chats: the same product as the web chat (docs/design/threadlink-0.11.md §8,
 * §9). A chat list beside the open chat; a compact header; ONE scrolling
 * timeline; a sticky composer; a right drawer for Activity, Progress,
 * Findings, Details and Provenance. Main hands over plain-text views only
 * (placement already decided by the shared presentation rules); everything
 * here is set with textContent.
 *
 * Performance: an open chat is built once and then only APPENDED to; state
 * snapshots never rebuild it. Polling uses the per-chat cursor with backoff,
 * slows down when the window is hidden, and the DOM keeps a bounded number of
 * rows.
 */

const HOME_CHATS = 5;
const CHAT_LIST_TTL_MS = 15_000;
const POLL_MIN_MS = 2_000;
const POLL_IDLE_MAX_MS = 15_000;
const POLL_ERROR_MAX_MS = 60_000;
const POLL_HIDDEN_MS = 30_000;
const MAX_ROWS = 400;
const MAX_ACTIVITY = 300;
const READ_EVERY_MS = 10_000;
/** Stick to the bottom only when this close to it (§8). */
const STICK_PX = 120;
/** Consecutive messages from one author within this window are grouped. */
const GROUP_MS = 5 * 60_000;

const CHAT_ERRORS = {
  invalid: "That message could not be sent as it is.",
  rate_limited: "Slow down a moment, then try again.",
  unavailable: "This computer isn't connected to ThreadLink right now.",
  not_found: "That chat was not found.",
  signed_out: "This computer's ThreadLink sign-in has expired. Sign in again.",
  failed: "Couldn't reach ThreadLink. Try again.",
};
const chatError = (r) =>
  typeof r?.message === "string" && r.message
    ? r.message
    : (CHAT_ERRORS[r?.error] ?? CHAT_ERRORS.failed);

/**
 * "You": this app's own connection to ThreadLink, from its own requests —
 * never from the execution host (§4).
 */
const you = { ok: null };
function noteRequest(res) {
  if (res?.ok) you.ok = true;
  else if (!res || res.error === "failed") you.ok = false;
}
const youText = () =>
  you.ok === false ? "You · Reconnecting" : you.ok ? "You · Connected" : "You · Connecting…";

/** The chat list, projects and the rest of one overview answer. */
const chatList = {
  sections: [],
  rows: [],
  projects: [],
  projectChoices: [],
  needsYou: [],
  failover: null,
  computer: null,
  unread: 0,
  groupBy: "recent",
  loadedAt: 0,
  loading: false,
  error: null,
};

async function loadChatList() {
  const overview = typeof api.chatsOverview === "function";
  if (chatList.loading || (!overview && typeof api.listChats !== "function")) return;
  chatList.loading = true;
  let res = null;
  try {
    res = overview
      ? await api.chatsOverview(chatList.groupBy)
      : await api.listChats(chatList.groupBy);
  } catch {
    res = null;
  }
  noteRequest(res);
  chatList.loading = false;
  chatList.loadedAt = Date.now();
  if (res?.ok && Array.isArray(res.sections)) {
    chatList.sections = res.sections;
    chatList.rows = res.sections.flatMap((s) => s.rows ?? []);
    chatList.projects = Array.isArray(res.projects) ? res.projects : [];
    chatList.projectChoices = Array.isArray(res.projectChoices) ? res.projectChoices : [];
    chatList.needsYou = Array.isArray(res.needsYou) ? res.needsYou : [];
    chatList.failover = res.failover ?? null;
    chatList.computer = res.computer ?? null;
    chatList.unread = typeof res.unread === "number" ? res.unread : 0;
    chatList.error = null;
  } else {
    chatList.error = chatError(res);
  }
  // An open chat is never rebuilt: only its sidebar list is refreshed.
  if (section === "chats" && chatView.mounted) {
    renderChatSidebar();
    renderNav();
    return;
  }
  if (["chats", "home", "projects", "notifications", "settings", "runtime"].includes(section))
    render();
  else renderNav();
}

function ensureChatList() {
  if (!chatList.loading && Date.now() - chatList.loadedAt > CHAT_LIST_TTL_MS) void loadChatList();
}

/** One chat row: name, unread, project · agents, mode and state. */
function chatRowNode(r) {
  const item = document.createElement("button");
  item.type = "button";
  item.className = `item chat-row${r.unread ? " unread" : ""}`;
  item.setAttribute("aria-current", r.chatId === chatView.id ? "true" : "false");
  const body = document.createElement("div");
  body.className = "item-body";
  const title = document.createElement("div");
  title.className = "title chat-row-name";
  title.textContent = r.name;
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = [r.project, r.participants].filter(Boolean).join(" · ");
  body.append(title, meta);
  const tags = document.createElement("div");
  tags.className = "tags";
  if (r.unread) {
    const dot = document.createElement("span");
    dot.className = "unread-dot";
    dot.setAttribute("aria-label", "Unread");
    dot.textContent = r.unreadCount > 1 ? String(Math.min(r.unreadCount, 99)) : "";
    tags.append(dot);
  }
  tags.append(badge(r.modeBadge, "mode"));
  if (r.state !== "Ready") tags.append(badge(r.state, r.stateTone));
  item.append(body, tags);
  item.addEventListener("click", () => openChat(r.chatId));
  return item;
}

function renderChatRows(node, { limit = Infinity, sections = false } = {}) {
  if (!node) return;
  node.replaceChildren();
  if (typeof api.chatsOverview !== "function" && typeof api.listChats !== "function") return;
  ensureChatList();
  if (chatList.error && !chatList.rows.length) {
    node.append(empty(chatList.error));
    return;
  }
  if (!chatList.rows.length) {
    node.append(
      empty(chatList.loadedAt ? "No chats yet. Start one with New chat." : "Loading your chats…"),
    );
    return;
  }
  if (!sections) {
    for (const r of chatList.rows.slice(0, limit)) node.append(chatRowNode(r));
    return;
  }
  for (const s of chatList.sections) {
    const group = document.createElement("div");
    group.className = "stack tight chat-section";
    const h = document.createElement("h3");
    h.className = "chat-section-title";
    h.textContent = s.title;
    group.append(h);
    for (const r of s.rows ?? []) group.append(chatRowNode(r));
    node.append(group);
  }
}

// ------------------------------------------------------------ Chats page

function renderChats() {
  // An open chat fills the inset; otherwise the page lists the chats.
  if (chatView.id) return mountChat(view);
  view.append(tpl("chats"));
  renderChatSidebar();
  for (const [id, groupBy] of [
    ["chats-by-recent", "recent"],
    ["chats-by-project", "project"],
  ]) {
    const b = el(id);
    b.setAttribute("aria-pressed", chatList.groupBy === groupBy ? "true" : "false");
    b.addEventListener("click", () => {
      if (chatList.groupBy === groupBy) return;
      chatList.groupBy = groupBy;
      chatList.loadedAt = 0;
      el("chats-by-recent")?.setAttribute("aria-pressed", String(groupBy === "recent"));
      el("chats-by-project")?.setAttribute("aria-pressed", String(groupBy === "project"));
      void loadChatList();
    });
  }
  el("new-chat").addEventListener("click", () => toggleNewChat(true));
}

/** The chat list: the sidebar's sub-list, and the Chats page when no chat is open. */
function renderChatSidebar() {
  if (el("chat-list")) renderChatRows(el("chat-list"), { sections: true });
  if (state) renderNav();
}

/** New chat: a name, a project and a mode. Main validates all three again. */
function toggleNewChat(open) {
  const form = el("new-chat-form");
  if (!form) return;
  form.hidden = !open;
  if (!open) return;
  form.replaceChildren();
  const name = document.createElement("input");
  name.type = "text";
  name.maxLength = 100;
  name.placeholder = "Chat name";
  name.id = "new-chat-name";
  const project = document.createElement("select");
  project.id = "new-chat-project";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "No project yet";
  project.append(none);
  for (const p of chatList.projectChoices) {
    const o = document.createElement("option");
    o.value = p.roomId;
    o.textContent = p.name;
    project.append(o);
  }
  const mode = document.createElement("select");
  mode.id = "new-chat-mode";
  for (const [value, label] of [
    ["team", "Team"],
    ["pair", "Pair"],
    ["solo", "Solo"],
  ]) {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    mode.append(o);
  }
  const row = document.createElement("div");
  row.className = "row";
  const create = document.createElement("button");
  create.type = "button";
  create.className = "primary small-btn";
  create.textContent = "Create";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "ghost small-btn";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => toggleNewChat(false));
  const problem = document.createElement("p");
  problem.className = "small danger-text";
  problem.hidden = true;
  create.addEventListener("click", async () => {
    const text = name.value.trim();
    if (!text) {
      problem.textContent = "Give the chat a name.";
      problem.hidden = false;
      return;
    }
    create.disabled = true;
    let res = null;
    try {
      res = await api.createChat({
        name: text,
        roomId: project.value || null,
        mode: mode.value,
      });
    } catch {
      res = null;
    }
    noteRequest(res);
    create.disabled = false;
    if (!res?.ok) {
      problem.textContent = chatError(res);
      problem.hidden = false;
      return;
    }
    chatList.loadedAt = 0;
    void loadChatList();
    openChat(res.chat.chatId);
  });
  row.append(create, cancel);
  form.append(name, project, mode, row, problem);
  name.focus?.();
}

// -------------------------------------------------------------- one chat

const chatView = {
  id: null,
  mounted: false,
  gen: 0,
  cursor: 0,
  oldest: null,
  hasOlder: false,
  rows: new Map(),
  timer: null,
  delay: POLL_MIN_MS,
  pending: null,
  sending: false,
  lastRead: 0,
  readAt: 0,
  header: null,
  working: false,
  presence: null,
  live: [],
  /** Drawer data: routine rows, findings and provenance, all bounded. */
  activity: [],
  findings: new Map(),
  provenance: [],
  cards: new Map(),
  deliveryNodes: new Map(),
  byId: new Map(),
  lastAuthor: null,
  unseen: 0,
  lane: "auto",
  drawer: null,
  mention: null,
};

function openChat(chatId) {
  stopChat();
  chatView.id = chatId;
  section = "chats";
  changing = null;
  render();
}

function stopChat() {
  clearTimeout(chatView.timer);
  chatView.timer = null;
  chatView.mounted = false;
  chatView.gen++;
}

/** A fresh idempotency key per message (reused only to retry that same message). */
function newKey() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function clock(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function blocksInto(node, blocks) {
  node.replaceChildren();
  for (const b of blocks ?? []) {
    if (b.t === "code") {
      const pre = document.createElement("pre");
      pre.className = "code-block";
      const code = document.createElement("code");
      code.textContent = b.v;
      pre.append(code);
      node.append(pre);
    } else {
      const p = document.createElement("p");
      p.className = "msg-text";
      p.textContent = b.v;
      node.append(p);
    }
  }
}

function bodyNode(ev) {
  const wrap = document.createElement("div");
  wrap.className = "msg-content";
  const body = document.createElement("div");
  body.className = "msg-body";
  blocksInto(body, ev.body.preview);
  wrap.append(body);
  if (ev.body.collapsed && ev.body.full) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "ghost small-btn msg-more";
    more.textContent = "Show more";
    let open = false;
    more.addEventListener("click", () => {
      open = !open;
      blocksInto(body, open ? ev.body.full : ev.body.preview);
      more.textContent = open ? "Show less" : "Show more";
    });
    wrap.append(more);
    if (ev.body.truncated) {
      const note = document.createElement("p");
      note.className = "muted small";
      note.textContent = "Very long message: the rest is in ThreadLink on the web.";
      wrap.append(note);
    }
  }
  return wrap;
}

const chatWebUrl = () =>
  state?.baseUrl && chatView.id ? `${state.baseUrl}/dashboard/chats/${chatView.id}` : null;

/** A choice card (§5, §6): buttons only for what the desktop may answer. */
function choiceNode(card) {
  const box = document.createElement("div");
  box.className = "choice-card";
  box.dataset.choice = card.choiceId;
  const title = document.createElement("p");
  title.className = "choice-title";
  title.textContent = card.title;
  box.append(title);
  const actions = document.createElement("div");
  actions.className = "row choice-actions";
  const note = document.createElement("p");
  note.className = "small muted choice-note";
  note.hidden = true;
  box.append(actions, note);
  const entry = { card, box, actions, note, busy: false };
  paintChoice(entry);
  return entry;
}

function paintChoice(entry) {
  const { card, actions, note } = entry;
  actions.replaceChildren();
  note.hidden = true;
  if (card.status !== "pending") {
    note.replaceChildren(
      icon("check", 13, 2.4),
      document.createTextNode(card.chosenLabel ? `Answered: ${card.chosenLabel}` : "Decided"),
    );
    note.hidden = false;
    entry.box.classList.add("decided");
    return;
  }
  if (card.approval || entry.superseded) {
    const open = document.createElement("button");
    open.type = "button";
    open.className = "ghost small-btn";
    open.textContent = "Decide in ThreadLink on the web";
    open.addEventListener("click", () => {
      const url = chatWebUrl();
      if (url) api.openExternal(url);
      else api.openDashboard();
    });
    actions.append(open);
    note.textContent = entry.superseded
      ? "A newer question replaced this one."
      : "Approvals are decided on the card in ThreadLink on the web.";
    note.hidden = false;
    return;
  }
  for (const o of card.options) {
    if (!o.answerable) continue;
    const b = document.createElement("button");
    b.type = "button";
    b.className =
      o === card.options.find((x) => x.answerable) ? "primary small-btn" : "ghost small-btn";
    b.textContent = o.label;
    b.dataset.option = o.key;
    b.addEventListener("click", () => void answerChoice(entry, o));
    actions.append(b);
  }
  if (card.options.some((o) => !o.answerable)) {
    note.textContent = "More options are in ThreadLink on the web.";
    note.hidden = false;
  }
}

async function answerChoice(entry, option) {
  if (entry.busy || typeof api.answerChoice !== "function") return;
  entry.busy = true;
  for (const b of entry.actions.querySelectorAll("button")) b.disabled = true;
  const gen = chatView.gen;
  let res = null;
  try {
    res = await api.answerChoice(chatView.id, entry.card.choiceId, option.key, newKey());
  } catch {
    res = null;
  }
  noteRequest(res);
  if (gen !== chatView.gen) return;
  entry.busy = false;
  if (res?.ok) {
    entry.card = { ...entry.card, status: "chosen", chosenLabel: res.chosenLabel ?? option.label };
    paintChoice(entry);
    chatView.delay = POLL_MIN_MS;
    clearTimeout(chatView.timer);
    void poll(gen);
    return;
  }
  for (const b of entry.actions.querySelectorAll("button")) b.disabled = false;
  showProblem(chatError(res));
}

/** One chat-placement row: owner right, agents left with an initial, ThreadLink quiet. */
function eventNode(raw, prev) {
  const kind = raw.identity?.kind;
  const ev = {
    ...raw,
    side: raw.side ?? (kind === "you" ? "right" : kind === "threadlink" ? "center" : "left"),
    identity: {
      ...raw.identity,
      initial: raw.identity?.initial ?? (raw.identity?.label ?? "?")[0],
    },
  };
  const item = document.createElement("article");
  item.className = `msg side-${ev.side} id-${ev.identity.kind}${ev.note ? " note" : ""}`;
  item.dataset.seq = String(ev.seq);
  if (ev.identity.provider) item.dataset.provider = ev.identity.provider;
  // Remembered (bounded) for "Replying to …" quotes on later rows.
  if (ev.id) {
    const text = (ev.body.preview[0]?.v ?? "").replace(/\s+/g, " ").trim();
    chatView.byId.set(ev.id, { who: ev.identity.short ?? ev.identity.label, text });
    if (chatView.byId.size > MAX_ROWS) chatView.byId.delete(chatView.byId.keys().next().value);
  }
  if (ev.identity.hue !== null && ev.identity.hue !== undefined)
    item.dataset.hue = String(ev.identity.hue);
  item.title = clock(ev.at);
  const author = `${ev.identity.kind}:${ev.identity.label}`;
  const grouped =
    prev &&
    prev.author === author &&
    ev.side !== "center" &&
    Math.abs(Date.parse(ev.at) - Date.parse(prev.at)) < GROUP_MS;
  if (grouped) item.classList.add("cont");

  if (ev.side === "left") {
    const avatar = document.createElement("span");
    avatar.className = "avatar";
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent = ev.identity.initial;
    item.append(avatar);
  }
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (ev.side === "left") {
    const who = document.createElement("div");
    who.className = "msg-who";
    who.textContent = ev.identity.short ?? ev.identity.label;
    if (ev.identity.role) {
      const role = document.createElement("span");
      role.className = "msg-role";
      role.textContent = ` · ${ev.identity.role}`;
      who.append(role);
    } else if (!ev.identity.short) who.textContent = ev.identity.label;
    bubble.append(who);
    const quoted = ev.replyTo ? chatView.byId.get(ev.replyTo) : null;
    if (quoted) {
      const q = document.createElement("div");
      q.className = "msg-reply";
      q.append(icon("reply", 14));
      const t = document.createElement("span");
      const words = quoted.text.length > 60 ? `${quoted.text.slice(0, 59)}…` : quoted.text;
      t.textContent = `Replying to ${quoted.who}${words ? ` · “${words}”` : ""}`;
      q.append(t);
      bubble.append(q);
    }
  }
  if (ev.side === "center" && !ev.card) {
    // ThreadLink's own rows: a quiet card; usage, failover and errors as the warm notice.
    const card = document.createElement("div");
    card.className = `system-card${ev.notice ? " notice" : ""}`;
    if (ev.notice) card.setAttribute("role", "status");
    const label = document.createElement("div");
    label.className = "system-label";
    if (ev.notice) label.append(icon("triangle-alert", 15));
    label.append(document.createTextNode("ThreadLink"));
    card.append(label, bodyNode(ev));
    bubble.append(card);
  } else if (ev.card) {
    const entry = choiceNode(ev.card);
    // Only the newest open question is answered from here.
    if (ev.card.status === "pending") {
      for (const other of chatView.cards.values()) {
        if (other.card.status === "pending" && !other.superseded) {
          other.superseded = true;
          paintChoice(other);
        }
      }
    }
    chatView.cards.set(ev.card.choiceId, entry);
    // The card carries the question; the row's text is shown only when it adds something.
    const first = (ev.body.preview[0]?.v ?? "").trim();
    if (first && !first.startsWith(ev.card.title.replace(/[.!?]+$/, "")))
      bubble.append(bodyNode(ev));
    bubble.append(entry.box);
  } else {
    bubble.append(bodyNode(ev));
  }
  if (ev.side === "right") {
    const meta = document.createElement("div");
    meta.className = "msg-meta";
    const when = document.createElement("span");
    when.className = "msg-when";
    when.textContent = clock(ev.at);
    meta.append(when);
    if (ev.delivery) {
      const d = document.createElement("span");
      d.className = "msg-delivery";
      d.textContent = ev.delivery;
      meta.append(d);
      chatView.deliveryNodes.set(ev.seq, d);
    }
    bubble.append(meta);
  }
  item.append(bubble);
  return { node: item, author, at: ev.at };
}

/** Routine rows go to the drawer; findings and provenance are remembered for it. */
function recordForDrawer(ev) {
  if (ev.finding) chatView.findings.set(ev.seq, ev.finding);
  if (ev.identity.kind === "agent")
    chatView.provenance.push({
      at: ev.at,
      who: ev.identity.full,
      role: ev.identity.role,
      model: ev.model,
    });
  if (chatView.provenance.length > 200)
    chatView.provenance.splice(0, chatView.provenance.length - 200);
  if (ev.placement !== "activity") return false;
  chatView.activity.push({
    seq: ev.seq,
    at: ev.at,
    who: ev.identity.short,
    text: ev.body.preview.map((b) => b.v).join("\n"),
  });
  if (chatView.activity.length > MAX_ACTIVITY)
    chatView.activity.splice(0, chatView.activity.length - MAX_ACTIVITY);
  return true;
}

const nearBottom = (box) => box.scrollHeight - box.scrollTop - box.clientHeight < STICK_PX;

function updateJump() {
  const pill = el("chat-jump");
  if (!pill) return;
  pill.hidden = chatView.unseen === 0;
  el("chat-jump-text").textContent =
    chatView.unseen > 0 ? `Jump to latest · ${chatView.unseen} new` : "Jump to latest";
}

/** Appends new rows (never re-renders), keeping at most MAX_ROWS. */
function appendEvents(events) {
  const list = el("chat-events");
  const box = el("chat-timeline");
  if (!list || !box) return 0;
  const stick = nearBottom(box);
  const frag = document.createDocumentFragment();
  let added = 0;
  let drawerChanged = false;
  for (const ev of events) {
    if (chatView.rows.has(ev.seq)) continue;
    if (chatView.oldest === null || ev.seq < chatView.oldest) chatView.oldest = ev.seq;
    if (recordForDrawer(ev)) {
      chatView.rows.set(ev.seq, null);
      drawerChanged = true;
      continue;
    }
    const made = eventNode(ev, chatView.lastAuthor);
    chatView.lastAuthor = made;
    chatView.rows.set(ev.seq, made.node);
    frag.append(made.node);
    added++;
  }
  if (drawerChanged) renderDrawer();
  if (!added) return 0;
  list.querySelector(".empty")?.remove();
  list.append(frag);
  // Bounded: drop the oldest rows; they can be loaded again.
  if (chatView.rows.size > MAX_ROWS && stick) {
    const seqs = [...chatView.rows.keys()].sort((a, b) => a - b);
    for (const seq of seqs.slice(0, chatView.rows.size - MAX_ROWS)) {
      chatView.rows.get(seq)?.remove();
      chatView.rows.delete(seq);
    }
    chatView.oldest = Math.min(...chatView.rows.keys());
    chatView.hasOlder = true;
    el("chat-older").hidden = false;
  }
  if (stick) {
    box.scrollTop = box.scrollHeight;
  } else {
    chatView.unseen += added;
    updateJump();
  }
  return added;
}

/** Older rows above, with the reading position kept where it was. */
function prependEvents(events) {
  const list = el("chat-events");
  const box = el("chat-timeline");
  if (!list || !box) return;
  const before = box.scrollHeight;
  const frag = document.createDocumentFragment();
  let prev = null;
  let drawerChanged = false;
  for (const ev of events) {
    if (chatView.rows.has(ev.seq)) continue;
    if (chatView.oldest === null || ev.seq < chatView.oldest) chatView.oldest = ev.seq;
    if (recordForDrawer(ev)) {
      chatView.rows.set(ev.seq, null);
      drawerChanged = true;
      continue;
    }
    const made = eventNode(ev, prev);
    prev = made;
    chatView.rows.set(ev.seq, made.node);
    frag.append(made.node);
  }
  if (drawerChanged) renderDrawer();
  list.prepend(frag);
  box.scrollTop += box.scrollHeight - before;
}

/** One compact row per working agent, at the bottom of the timeline. */
function renderLive(live) {
  chatView.live = live ?? [];
  const node = el("chat-live");
  if (!node) return;
  node.replaceChildren();
  chatView.live.slice(0, 12).forEach((r, i) => {
    const row = document.createElement("div");
    row.className = `live-row${i === 0 ? " shimmer" : ""}`;
    if (r.provider) row.dataset.provider = r.provider;
    const dot = document.createElement("span");
    dot.className = "live-dot";
    dot.setAttribute("aria-hidden", "true");
    const name = document.createElement("span");
    name.className = "live-name";
    name.textContent = r.label;
    const what = document.createElement("span");
    what.textContent = r.activity;
    row.append(dot, name, what);
    if (r.startedAt) {
      const when = document.createElement("span");
      when.className = "live-when";
      when.textContent = `· ${ago(r.startedAt)}`;
      row.append(when);
    }
    node.append(row);
  });
}

const PRESENCE_WORD = {
  online: "Online",
  working: "Working",
  reconnecting: "Reconnecting",
  offline: "Offline",
};

/** The status dot line, from what main said plus what polling has learned since. */
function paintStatus() {
  const h = chatView.header;
  if (!h || !el("chat-status-text")) return;
  const host = h.host;
  const presence = chatView.presence ?? host?.presence ?? null;
  let status = h.status;
  if (h.state === "Needs you") status = { text: "Needs you", tone: "wait" };
  else if (host && presence === "offline") status = { text: `${host.name} offline`, tone: "off" };
  else if (chatView.working) status = { text: "Working", tone: "run" };
  else if (host && presence === "reconnecting")
    status = { text: `${host.name} reconnecting`, tone: "warn" };
  else status = { text: "Ready", tone: "ready" };
  el("chat-status-text").textContent = status.text;
  el("chat-status-dot").className =
    `ping ${status.tone === "run" ? "run" : status.tone === "ready" ? "" : status.tone === "off" ? "off" : "wait"}`;
  const offline = el("chat-offline");
  const note =
    host && presence === "offline"
      ? (host.offlineNote ??
        `You're connected. ${host.name} is offline — repository work and agent replies will resume when it reconnects.`)
      : null;
  offline.textContent = note ?? "";
  offline.hidden = !note;
  el("chat-stop").hidden = !chatView.working;
}

function applyPage(page) {
  chatView.cursor = Math.max(chatView.cursor, page.cursor ?? 0);
  const added = appendEvents(page.events ?? []);
  for (const r of page.resolved ?? []) {
    const entry = chatView.cards.get(r.choiceId);
    if (entry && entry.card.status === "pending") {
      entry.card = {
        ...entry.card,
        status: "chosen",
        chosenLabel: r.label ?? entry.card.chosenLabel,
      };
      paintChoice(entry);
    }
  }
  for (const d of page.deliveries ?? []) {
    const node = chatView.deliveryNodes.get(d.seq);
    if (node) node.textContent = d.text;
  }
  renderLive(page.live);
  chatView.working = page.working === true;
  if (page.hostPresence) chatView.presence = page.hostPresence;
  paintStatus();
  if (chatView.drawer === "progress") renderDrawer();
  return added;
}

async function markRead() {
  if (typeof api.markChatRead !== "function") return;
  if (chatView.cursor <= chatView.lastRead || Date.now() - chatView.readAt < READ_EVERY_MS) return;
  chatView.readAt = Date.now();
  const seq = chatView.cursor;
  try {
    const r = await api.markChatRead(chatView.id, seq);
    if (r?.ok) {
      chatView.lastRead = seq;
      // The same unread state as the web: this chat is read now.
      const row = chatList.rows.find((x) => x.chatId === chatView.id);
      if (row?.unread) {
        row.unread = false;
        row.unreadCount = 0;
        renderChatSidebar();
      }
    }
  } catch {
    /* advisory */
  }
}

function schedulePoll(gen) {
  clearTimeout(chatView.timer);
  const hidden = document.visibilityState === "hidden";
  const delay = hidden ? Math.max(chatView.delay, POLL_HIDDEN_MS) : chatView.delay;
  chatView.timer = setTimeout(() => void poll(gen), delay);
}

async function poll(gen) {
  if (gen !== chatView.gen || !chatView.mounted) return;
  let res = null;
  try {
    res = await api.chatEvents(chatView.id, { after: chatView.cursor });
  } catch {
    res = null;
  }
  noteRequest(res);
  if (gen !== chatView.gen) return;
  if (res?.ok) {
    const added = applyPage(res.page);
    chatView.delay = added
      ? POLL_MIN_MS
      : Math.min(POLL_IDLE_MAX_MS, Math.round(chatView.delay * 1.5));
    if (added) void markRead();
  } else {
    chatView.delay = Math.min(POLL_ERROR_MAX_MS, Math.max(5_000, chatView.delay * 2));
  }
  if (chatView.drawer === "details") renderDrawer();
  schedulePoll(gen);
}

// ------------------------------------------------------------------ drawer

const DRAWER_TABS = [
  { id: "activity", label: "Activity" },
  { id: "progress", label: "Progress" },
  { id: "findings", label: "Findings" },
  { id: "details", label: "Details" },
  { id: "provenance", label: "Provenance" },
];

function openDrawer(tab) {
  chatView.drawer = chatView.drawer === tab ? null : tab;
  renderDrawer();
}

function drawerLine(text, meta) {
  const row = document.createElement("div");
  row.className = "drawer-row";
  const t = document.createElement("div");
  t.className = "drawer-text";
  t.textContent = text;
  row.append(t);
  if (meta) {
    const m = document.createElement("div");
    m.className = "muted small";
    m.textContent = meta;
    row.append(m);
  }
  return row;
}

function renderDrawer() {
  const drawer = el("chat-drawer");
  if (!drawer) return;
  drawer.hidden = !chatView.drawer;
  if (!chatView.drawer) return;
  const tabs = el("drawer-tabs");
  tabs.replaceChildren();
  for (const t of DRAWER_TABS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "drawer-tab";
    b.textContent = t.label;
    b.setAttribute("aria-selected", t.id === chatView.drawer ? "true" : "false");
    b.addEventListener("click", () => {
      chatView.drawer = t.id;
      renderDrawer();
    });
    tabs.append(b);
  }
  const body = el("drawer-body");
  body.replaceChildren();
  const tab = chatView.drawer;
  el("drawer-title").textContent = DRAWER_TABS.find((t) => t.id === tab)?.label ?? "Details";
  if (tab === "activity") {
    if (!chatView.activity.length)
      body.append(empty("Nothing yet. Routine updates from ThreadLink show up here."));
    for (const a of chatView.activity.slice(-100).reverse())
      body.append(drawerLine(a.text, `${a.who} · ${clock(a.at)}`));
  } else if (tab === "progress") {
    const h = chatView.header;
    body.append(drawerLine(chatView.working ? "Working" : "Nothing running", h ? h.state : null));
    for (const r of chatView.live)
      body.append(drawerLine(`${r.label} · ${r.activity}`, r.startedAt ? ago(r.startedAt) : null));
    // The honest stages, when that work runs on this computer.
    const group = workOf(state).find((g) => g.key === `chat:${chatView.id}`);
    for (const job of group?.jobs ?? []) body.append(teamJob(job));
  } else if (tab === "findings") {
    const all = [...chatView.findings.values()];
    if (!all.length) body.append(empty("No findings in this chat."));
    for (const f of all.reverse())
      body.append(drawerLine(f.title, `${f.severity} · ${f.open ? "Open" : f.status}`));
  } else if (tab === "details") {
    const h = chatView.header;
    const section = (title, pairs) => {
      const label = document.createElement("div");
      label.className = "drawer-label";
      label.textContent = title;
      body.append(label);
      for (const [k, v] of pairs) {
        const row = document.createElement("div");
        row.className = "drawer-pair";
        const a = document.createElement("span");
        a.textContent = k;
        const b = document.createElement("span");
        b.className = "v";
        b.textContent = v;
        row.append(a, b);
        body.append(row);
      }
    };
    section("Connection", [
      ["You", youText().replace("You · ", "")],
      ["ThreadLink service", you.ok === false ? "Reconnecting" : "Connected"],
      ["Execution host", h?.host ? h.host.text : "No project yet — no computer runs it"],
    ]);
    if (h) {
      section("Agents", [["Agents", h.participants.map((p) => p.full).join(", ") || "None yet"]]);
      section("Chat", [
        ["Mode", h.modeBadge],
        ["Project", h.sub.split(" · ")[0] ?? ""],
      ]);
    }
    const open = document.createElement("button");
    open.type = "button";
    open.className = "ghost small-btn";
    open.textContent = "Open in ThreadLink on the web";
    open.addEventListener("click", () => {
      const url = chatWebUrl();
      if (url) api.openExternal(url);
    });
    body.append(open);
  } else if (tab === "provenance") {
    if (!chatView.provenance.length) body.append(empty("No agent messages yet."));
    for (const p of chatView.provenance.slice(-100).reverse())
      body.append(
        drawerLine(
          `${p.who}${p.role ? ` · ${p.role}` : ""}`,
          `${p.model ? `Model ${p.model} · ` : ""}${clock(p.at)}`,
        ),
      );
  }
}

// ---------------------------------------------------------------- composer

const LANES = [
  { id: "auto", label: "Auto" },
  { id: "chat", label: "Chat only" },
  { id: "work", label: "Run work" },
];

function paintLane() {
  const box = el("chat-lane");
  if (!box) return;
  box.replaceChildren();
  for (const l of LANES) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "lane-option";
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", l.id === chatView.lane ? "true" : "false");
    b.textContent = l.label;
    b.addEventListener("click", () => {
      chatView.lane = l.id;
      box.hidden = true;
      paintLane();
    });
    box.append(b);
  }
  const label = el("chat-lane-label");
  if (label) label.textContent = LANES.find((l) => l.id === chatView.lane)?.label ?? "Auto";
  el("chat-lane-chip")?.setAttribute("aria-expanded", box.hidden ? "false" : "true");
}

/** Autosize: grows with the text up to a limit, measured only on input. */
function autosize(input) {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight || 0, 200)}px`;
}

/** @mention candidates from the chat's agents, plus @team. */
function mentionState(input) {
  const upto = input.value.slice(0, input.selectionStart ?? input.value.length);
  const m = /(^|\s)@([a-z0-9-]{0,20})$/i.exec(upto);
  if (!m) return null;
  const q = m[2].toLowerCase();
  const people = [
    ...(chatView.header?.participants ?? []).map((p) => ({ handle: p.handle, label: p.short })),
    { handle: "team", label: "Everyone" },
  ];
  const items = people.filter((p) => p.handle.startsWith(q));
  return items.length ? { start: upto.length - q.length - 1, items, index: 0 } : null;
}

function paintMentions() {
  const list = el("mention-list");
  if (!list) return;
  const m = chatView.mention;
  list.hidden = !m;
  list.replaceChildren();
  if (!m) return;
  m.items.forEach((item, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "mention";
    b.setAttribute("role", "option");
    b.setAttribute("aria-selected", i === m.index ? "true" : "false");
    b.textContent = `@${item.handle} · ${item.label}`;
    b.addEventListener("mousedown", (e) => {
      e.preventDefault();
      pickMention(i);
    });
    list.append(b);
  });
}

function pickMention(i) {
  const input = el("chat-input");
  const m = chatView.mention;
  if (!input || !m) return;
  const item = m.items[i] ?? m.items[0];
  const caret = input.selectionStart ?? input.value.length;
  input.value = `${input.value.slice(0, m.start)}@${item.handle} ${input.value.slice(caret)}`;
  const pos = m.start + item.handle.length + 2;
  input.setSelectionRange?.(pos, pos);
  chatView.mention = null;
  paintMentions();
  autosize(input);
}

/** Builds the chat view once; afterwards it only grows. */
function mountChat(pane) {
  pane.append(tpl("chat"));
  Object.assign(chatView, {
    mounted: true,
    rows: new Map(),
    cursor: 0,
    oldest: null,
    hasOlder: false,
    delay: POLL_MIN_MS,
    lastRead: 0,
    readAt: 0,
    header: null,
    working: false,
    presence: null,
    live: [],
    activity: [],
    findings: new Map(),
    provenance: [],
    cards: new Map(),
    deliveryNodes: new Map(),
    byId: new Map(),
    lastAuthor: null,
    unseen: 0,
    lane: "auto",
    drawer: null,
    mention: null,
  });
  const gen = ++chatView.gen;
  const id = chatView.id;

  el("chat-older").addEventListener("click", () => void loadOlder(gen));
  el("chat-more").addEventListener("click", () => openDrawer("details"));
  el("chat-status").addEventListener("click", () => openDrawer("progress"));
  el("drawer-close").addEventListener("click", () => {
    chatView.drawer = null;
    renderDrawer();
  });
  const box = el("chat-timeline");
  box.addEventListener(
    "scroll",
    () => {
      if (chatView.unseen && nearBottom(box)) {
        chatView.unseen = 0;
        updateJump();
      }
    },
    { passive: true },
  );
  el("chat-jump").addEventListener("click", () => {
    box.scrollTop = box.scrollHeight;
    chatView.unseen = 0;
    updateJump();
  });
  el("chat-stop").addEventListener("click", () => void sendMessage(gen, "stop"));
  el("chat-sidebar-toggle")?.addEventListener("click", () => toggleSidebar());
  el("chat-lane-chip").addEventListener("click", () => {
    const menu = el("chat-lane");
    menu.hidden = !menu.hidden;
    paintLane();
  });
  paintLane();
  const input = el("chat-input");
  el("chat-mention").addEventListener("click", () => {
    const caret = input.selectionStart ?? input.value.length;
    const before = input.value.slice(0, caret);
    const lead = before && !/\s$/.test(before) ? " @" : "@";
    input.value = `${before}${lead}${input.value.slice(caret)}`;
    const pos = caret + lead.length;
    input.focus();
    input.setSelectionRange?.(pos, pos);
    input.dispatchEvent(new Event("input"));
  });
  el("chat-send").addEventListener("click", () => void sendMessage(gen));
  input.addEventListener("input", () => {
    autosize(input);
    chatView.mention = mentionState(input);
    paintMentions();
  });
  // Cheap: the handler only looks at the key; sending happens off the event.
  input.addEventListener("keydown", (e) => {
    const m = chatView.mention;
    if (m && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      m.index = (m.index + (e.key === "ArrowDown" ? 1 : m.items.length - 1)) % m.items.length;
      paintMentions();
      return;
    }
    if (m && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey))) {
      e.preventDefault();
      pickMention(m.index);
      return;
    }
    if (m && e.key === "Escape") {
      chatView.mention = null;
      paintMentions();
      return;
    }
    if (e.key === "Escape" && chatView.drawer) {
      chatView.drawer = null;
      renderDrawer();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void sendMessage(gen);
    }
  });

  if (typeof api.openChat !== "function") return;
  void (async () => {
    let res = null;
    try {
      res = await api.openChat(id);
    } catch {
      res = null;
    }
    noteRequest(res);
    if (gen !== chatView.gen) return;
    if (!res?.ok) {
      el("chat-title").textContent = "Chat";
      showProblem(chatError(res));
      schedulePoll(gen);
      return;
    }
    const h = res.chat;
    chatView.header = h;
    el("chat-title").textContent = h.name;
    el("chat-mode").textContent = h.modeBadge;
    el("chat-sub").textContent = h.sub;
    input.placeholder = h.participants.length
      ? `Message ${h.participants.map((p) => p.short).join(" and ")} — @ to address one`
      : "Message this chat";
    chatView.hasOlder = res.page.hasOlder === true;
    el("chat-older").hidden = !chatView.hasOlder;
    applyPage(res.page);
    if (!el("chat-events").children.length) {
      el("chat-events").append(empty("No messages yet. Say what you want done."));
    }
    box.scrollTop = box.scrollHeight;
    void markRead();
    schedulePoll(gen);
  })();
}

async function loadOlder(gen) {
  if (!chatView.hasOlder || chatView.oldest === null) return;
  const button = el("chat-older");
  button.disabled = true;
  let res = null;
  try {
    res = await api.chatEvents(chatView.id, { before: chatView.oldest });
  } catch {
    res = null;
  }
  noteRequest(res);
  if (gen !== chatView.gen) return;
  button.disabled = false;
  if (!res?.ok) return showProblem(chatError(res));
  prependEvents(res.page.events ?? []);
  chatView.hasOlder = res.page.hasOlder === true;
  button.hidden = !chatView.hasOlder;
}

function showProblem(text) {
  const p = el("chat-problem");
  if (!p) return;
  p.textContent = text ?? "";
  p.hidden = !text;
}

/**
 * Sends the composer's text (or a fixed word such as "stop"). One key per
 * message; a retry of the same text reuses it, so a send that reached
 * ThreadLink but lost its answer is never posted twice.
 */
async function sendMessage(gen, fixed) {
  const input = el("chat-input");
  const button = el("chat-send");
  if (!input || chatView.sending || typeof api.sendChat !== "function") return;
  const body = fixed ?? input.value.trim();
  if (!body) return;
  if (body.length > 4000) return showProblem("That message is too long (4000 characters at most).");
  const lane = fixed ? "auto" : chatView.lane;
  const key =
    chatView.pending?.body === body && chatView.pending?.lane === lane
      ? chatView.pending.key
      : newKey();
  chatView.pending = { body, key, lane };
  chatView.sending = true;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  showProblem(null);
  let res = null;
  try {
    res =
      lane === "auto"
        ? await api.sendChat(chatView.id, body, key)
        : await api.sendChat(chatView.id, body, key, lane);
  } catch {
    res = null;
  }
  noteRequest(res);
  if (gen !== chatView.gen) return;
  chatView.sending = false;
  button.disabled = false;
  button.removeAttribute("aria-busy");
  if (res?.ok) {
    chatView.pending = null;
    if (!fixed && input.value.trim() === body) {
      input.value = "";
      autosize(input);
    }
    if (!fixed) {
      chatView.lane = "auto";
      paintLane();
    }
    if (res.routed === "choice_resolved") {
      // The message answered the open question (§6): say so on its card.
      const open = [...chatView.cards.values()].reverse().find((c) => c.card.status === "pending");
      if (open) {
        open.card = { ...open.card, status: "chosen", chosenLabel: res.chosenLabel ?? null };
        paintChoice(open);
      }
    }
    // What you sent is on screen at once: follow it to the bottom.
    const box = el("chat-timeline");
    if (box) box.scrollTop = box.scrollHeight;
    chatView.delay = POLL_MIN_MS;
    clearTimeout(chatView.timer);
    void poll(gen);
    return;
  }
  // A refusal the server answered for good (not a lost connection) is final.
  if (res?.message) chatView.pending = null;
  showProblem(chatError(res));
}

document.addEventListener("visibilitychange", () => {
  // Back on screen: catch up at once instead of waiting out a hidden delay.
  if (document.visibilityState === "visible" && chatView.mounted && section === "chats") {
    chatView.delay = POLL_MIN_MS;
    schedulePoll(chatView.gen);
  }
});

// ------------------------------------------------------------------- bits

function kv(node, pairs) {
  node.replaceChildren();
  for (const [k, v] of pairs) {
    const key = document.createElement("div");
    key.className = "k";
    key.textContent = k;
    const value = document.createElement("div");
    value.className = "v";
    value.textContent = v;
    node.append(key, value);
  }
}

function kvAppend(node, k, v) {
  const key = document.createElement("div");
  key.className = "k";
  key.textContent = k;
  const value = document.createElement("div");
  value.className = "v";
  value.textContent = v;
  node.append(key, value);
}

function badge(text, tone) {
  const node = document.createElement("span");
  node.className = `badge${tone ? ` ${tone}` : ""}`;
  node.textContent = text;
  return node;
}

/**
 * A Copy button for one value. The clipboard may be missing (or refuse), so
 * the button says what happened instead of failing silently.
 */
function bindCopy(button, value) {
  const reset = button.textContent;
  button.addEventListener("click", async () => {
    let said = "Copied";
    try {
      if (!navigator.clipboard?.writeText) throw new Error("no clipboard");
      await navigator.clipboard.writeText(value());
    } catch {
      said = "Copy not available";
    }
    button.textContent = said;
    setTimeout(() => (button.textContent = reset), 1500);
  });
}

/**
 * Identifiers and paths, one per row, each with its own Copy button. Rows with
 * no value are left out rather than shown as a dash.
 */
function copyRows(node, pairs) {
  node.replaceChildren();
  node.classList.add("copy-rows");
  let any = false;
  for (const [label, value] of pairs) {
    if (value === null || value === undefined || value === "") continue;
    any = true;
    const row = document.createElement("div");
    row.className = "copy-row";
    const k = document.createElement("div");
    k.className = "k";
    k.textContent = label;
    const v = document.createElement("code");
    v.className = "v";
    v.textContent = String(value);
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "ghost small-btn copy";
    copy.textContent = "Copy";
    copy.setAttribute("aria-label", `Copy ${label}`);
    bindCopy(copy, () => String(value));
    row.append(k, v, copy);
    node.append(row);
  }
  if (!any) node.append(empty("Nothing to show yet."));
  return any;
}

/** A closed "Technical details" section, or null when there is nothing in it. */
function techDetails(pairs) {
  const details = document.createElement("details");
  details.className = "tech";
  const summary = document.createElement("summary");
  summary.textContent = "Technical details";
  const body = document.createElement("div");
  details.append(summary, body);
  return copyRows(body, pairs) ? details : null;
}

function empty(text) {
  const node = document.createElement("div");
  node.className = "empty";
  node.textContent = text;
  return node;
}

function row(title, meta, actionLabel, badge) {
  const item = document.createElement("div");
  item.className = "item";
  const left = document.createElement("div");
  left.className = "item-body";
  const t = document.createElement("div");
  t.className = "title";
  t.textContent = title;
  const m = document.createElement("div");
  m.className = "meta";
  m.textContent = meta ?? "";
  left.append(t, m);
  const right = document.createElement("div");
  right.className = "row";
  if (badge) {
    const b = document.createElement("span");
    b.className = `badge${badge === "Ready" ? " ready" : ""}`;
    b.textContent = badge;
    right.append(b);
  }
  if (actionLabel) {
    const button = document.createElement("button");
    button.className = "small-btn";
    button.textContent = actionLabel;
    right.append(button);
  }
  item.append(left, right);
  return item;
}

function nameOf(path) {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

el("open-dashboard").addEventListener("click", () => api.openDashboard());
el("sidebar-toggle").addEventListener("click", () => toggleSidebar());
/** Snapshots can arrive in bursts; one render per burst is enough. */
let renderQueued = false;
api.onState((next) => {
  state = next;
  if (renderQueued) return;
  renderQueued = true;
  queueMicrotask(() => {
    renderQueued = false;
    render();
  });
});
api.getState().then((next) => {
  state = next;
  render();
});
