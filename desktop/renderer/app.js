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

const el = (id) => document.getElementById(id);
const tpl = (name) => document.getElementById(`tpl-${name}`).content.cloneNode(true);

const SECTIONS = [
  { id: "home", label: "Home", title: "Home" },
  { id: "chats", label: "Chats", title: "Chats" },
  { id: "agents", label: "Agents", title: "Agents" },
  { id: "runtime", label: "This computer", title: "This computer" },
  { id: "notifications", label: "Notifications", title: "Notifications" },
  { id: "settings", label: "Settings", title: "Settings" },
];

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

const conversationsOf = (s) => (s.snapshot?.workspaces ?? []).flatMap((w) => w.conversations);

function statusOf(s) {
  if (!s.signedIn) return { title: "Not connected", tone: "warn", detail: "" };
  const snap = s.snapshot;
  const attached = conversationsOf(s);
  if (snap?.status === "online" && attached.length) {
    // Only an exact-conversation binding can be blocked by Claude being open.
    const busy = attached.some((c) => c.mode === "resume" && c.busy);
    return {
      title: busy ? "Claude is currently open" : "Connected",
      tone: busy ? "busy" : "ready",
      detail: `${attached.length} conversation${attached.length === 1 ? "" : "s"} linked`,
    };
  }
  const map = {
    online: { title: "Choose a conversation", tone: "warn" },
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
  if (c.mode === "resume" && c.busy) return { label: "Claude is currently open", tone: "busy" };
  return { label: "Ready", tone: "ready" };
}

function render() {
  if (!state) return;
  const status = statusOf(state);
  el("status-title").textContent = status.title;
  el("status-dot").className = `dot ${status.tone}`;
  el("rail-status").textContent = status.title;
  el("rail-dot").className = `dot ${status.tone}`;
  el("footer-detail").textContent = state.error ?? state.notice ?? status.detail ?? "";

  view.replaceChildren();
  const mine = ++pass;
  const solo = (render) => {
    el("shell").className = "shell solo";
    el("page-title").textContent = "ThreadLink";
    el("page-sub").textContent = "";
    render();
  };
  if (state.pendingSignIn) return solo(renderWaiting);
  const why = attention(state);
  if (why) return solo(() => renderReconnect(why));
  if (!state.signedIn) return solo(renderSignIn);

  el("shell").className = "shell";
  renderNav();
  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];
  el("page-title").textContent = section === "attach" ? "Attach a conversation" : current.title;
  el("page-sub").textContent = subtitleFor();
  if (section === "attach") return void renderAttach(mine);
  if (section === "agents") return renderAgents();
  if (section === "chats") return renderChats();
  if (section === "runtime") return renderRuntime();
  if (section === "notifications") return renderNotifications();
  if (section === "settings") return renderSettings();
  return renderHome();
}

function subtitleFor() {
  const snap = state.snapshot;
  if (section === "home") return snap?.runtime?.label ?? snap?.identity?.label ?? "";
  if (section === "agents") {
    const n = conversationsOf(state).length;
    return n ? `${n} Claude conversation${n === 1 ? "" : "s"} attached` : "Nothing attached yet";
  }
  if (section === "chats") {
    const running = workOf(state).reduce((n, g) => n + g.running, 0);
    return running ? `${running} running` : "Running and recent work";
  }
  if (section === "runtime") return snap?.identity?.platform ?? "";
  return "";
}

function renderNav() {
  const nav = el("nav");
  nav.replaceChildren();
  const waiting = state.snapshot?.pendingLinks?.length ?? 0;
  for (const s of SECTIONS) {
    const button = document.createElement("button");
    button.type = "button";
    const label = document.createElement("span");
    label.textContent = s.label;
    button.append(label);
    if (s.id === "home" && waiting) {
      const count = document.createElement("span");
      count.className = "count";
      count.textContent = String(waiting);
      button.append(count);
    }
    const here = s.id === section || (section === "attach" && s.id === "agents");
    button.setAttribute("aria-current", here ? "true" : "false");
    button.addEventListener("click", () => go(s.id));
    nav.append(button);
  }
}

function go(next) {
  // Settings always re-reads the plan from ThreadLink when it is opened.
  if (next === "settings" && section !== "settings") {
    plans.stale = true;
    for (const k of Object.keys(planNote)) delete planNote[k];
    for (const k of Object.keys(planDraft)) delete planDraft[k];
  }
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
  const snap = state.snapshot;
  renderLinkRequests();
  renderSummary(el("home-summary"));
  renderHealth(el("home-health"));

  const list = el("home-conversations");
  list.replaceChildren();
  const all = (snap?.workspaces ?? []).flatMap((w) => w.conversations.map((c) => ({ w, c })));
  if (!all.length) {
    list.append(empty("No Claude conversation is linked yet."));
  }
  for (const { w, c } of all) list.append(conversationCard(w, c, false));

  const recent = el("home-activity");
  recent.replaceChildren(
    activityList(activityOf(state), {
      withConversation: true,
      limit: HOME_FEED_LIMIT,
      emptyText: "No activity yet. When a task runs, what it did shows up here.",
    }),
  );
  el("home-activity-dashboard").addEventListener("click", () => api.openDashboard());

  el("home-manage").addEventListener("click", () => go("agents"));
  el("mcp-url").textContent = `${state.baseUrl}/mcp`;
  bindCopy(el("copy-mcp"), () => `${state.baseUrl}/mcp`);
}

/** Who can work right now: Team Mode's view if it has one, else the classic providers. */
function agentsOnline(s) {
  const team = s.snapshot?.teamProviders ?? [];
  // A Runtime that probes health is believed over "signed in": status output
  // is not proof that a provider can actually run.
  if (team.some((p) => p && "health" in p))
    return healthOf(s)
      .filter((h) => h.health === "ready")
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
  const needs = waiting + decisions + blocked + signIn;
  const linked = conversationsOf(state).length;

  const tiles = [
    {
      label: "Agents online",
      value: online.length ? online.map(providerName).join(" · ") : "None",
      tone: online.length ? "ready" : "warn",
      go: "agents",
    },
    { label: "Conversations linked", value: String(linked), go: "agents" },
    { label: "Chats running", value: String(running), tone: running ? "run" : "", go: "chats" },
    {
      label: "Needs attention",
      value: needs ? String(needs) : "Nothing",
      tone: needs ? "warn" : "",
      go: decisions ? "chats" : signIn ? "agents" : null,
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

function renderAgents() {
  view.append(tpl("agents"));
  renderHealth(el("agents-health"));
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
      c.busy && attachMode === "resume" ? "Claude is currently open" : null,
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
  kv(el("runtime-kv"), [
    ["Name", snap?.runtime?.label ?? snap?.identity?.label ?? "—"],
    ["Computer", snap?.identity?.platform ?? "—"],
    ["State", paused ? "Paused" : statusOf(state).title],
    ["Last check-in", snap?.lastHeartbeatAt ? ago(snap.lastHeartbeatAt) : "connecting"],
    ["Requests handled", String(snap?.tasksCompleted ?? 0)],
  ]);
  const pause = el("pause");
  pause.textContent = paused ? "Resume" : "Pause";
  pause.addEventListener("click", () => api.setPaused(!paused));
  el("restart").addEventListener("click", () => api.restart());

  const workspaces = el("workspaces");
  workspaces.replaceChildren();
  if (!(snap?.workspaces ?? []).length) workspaces.append(empty("No project folders yet."));
  for (const w of snap?.workspaces ?? []) {
    workspaces.append(
      row(
        w.name,
        w.exists ? "Folder found" : "Folder missing — choose it again",
        null,
        `${w.conversations.length} attached`,
      ),
    );
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

// ----------------------------------------------------- notifications, settings

function renderNotifications() {
  view.append(tpl("notifications"));
  el("set-notifications").checked = state.settings.notifications;
  el("set-notifications").addEventListener("change", (e) =>
    api.setSettings({ notifications: e.target.checked }),
  );
}

function renderSettings() {
  view.append(tpl("settings"));
  el("set-autostart").checked = state.settings.autoStart;
  el("set-autostart").addEventListener("change", (e) =>
    api.setSettings({ autoStart: e.target.checked }),
  );
  renderProviders(el("providers"));
  const recheck = el("providers-check");
  if (recheck) recheck.replaceChildren(checkAgainRow());
  el("plan-dashboard").addEventListener("click", () => api.openDashboard());
  copyRows(el("settings-advanced"), [
    ["ThreadLink address", state.baseUrl],
    ["Connector URL", state.baseUrl ? `${state.baseUrl}/mcp` : null],
    ["This computer", state.snapshot?.identity?.kind],
  ]);
  el("signout").addEventListener("click", () => api.signOut());
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
  const head = document.createElement("div");
  head.className = "health-head";
  const dot = document.createElement("span");
  dot.className = `dot ${h.tone === "ready" ? "ready" : h.tone === "fail" ? "off" : "busy"}`;
  dot.setAttribute("aria-hidden", "true");
  const text = document.createElement("span");
  text.className = "health-line";
  text.textContent = h.line;
  head.append(dot, text);
  if (h.checkedAt) {
    const when = document.createElement("span");
    when.className = "muted small";
    when.textContent = `checked ${ago(h.checkedAt)}`;
    head.append(when);
  }
  line.append(head);
  if (h.instruction) {
    const how = document.createElement("p");
    how.className = "small health-instruction";
    how.textContent = h.instruction;
    line.append(how);
  }
  return line;
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
  if (section === "settings") render();
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

/** One card per Team Mode agent this computer knows about. */
function renderProviders(node) {
  if (!node) return;
  node.replaceChildren();
  const list = state.snapshot?.teamProviders ?? [];
  if (!list.length) {
    node.append(
      empty(
        "ThreadLink has not found Claude Code or Codex on this computer yet. Install one, then restart ThreadLink.",
      ),
    );
    return;
  }
  if (plans.fromCache && plans.views) {
    const stale = document.createElement("p");
    stale.className = "muted small";
    stale.textContent = "Showing the plan ThreadLink last sent. It couldn't be refreshed just now.";
    node.append(stale);
  }
  if (plans.stale && !plans.loading) void loadPlans();
  for (const p of list) {
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
      badge(health?.text ?? "Not checked yet", health?.tone ?? "wait"),
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
    if (health) card.append(healthLine(health));
    card.append(planBlock(p.provider), facts, models);
    const tech = techDetails([
      ["Version", p.version],
      ["Detail", p.detail],
    ]);
    if (tech) card.append(tech);
    node.append(card);
  }
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

function renderChats() {
  view.append(tpl("chats"));
  const list = el("chat-groups");
  list.replaceChildren();
  const groups = workOf(state);
  if (!groups.length) {
    const box = document.createElement("div");
    box.className = "card stack team-empty";
    const h = document.createElement("h2");
    h.textContent = "Nothing running yet";
    const what = document.createElement("p");
    what.className = "muted";
    what.textContent =
      "Chat with one AI, two AIs, or a team. Work that runs on this computer shows up here, " +
      "grouped by the chat it belongs to.";
    const how = document.createElement("p");
    how.className = "muted small";
    how.textContent =
      "Ask your controller (for example ChatGPT), or start a chat in ThreadLink on the web. " +
      "Its progress shows up here.";
    box.append(h, what, how);
    list.append(box);
    return;
  }
  for (const group of groups) list.append(chatGroup(group));
}

/** One chat (or, for older work with no chat, one room) and its jobs. */
function chatGroup(group) {
  const card = document.createElement("section");
  card.className = "card stack chat-group";
  const head = document.createElement("div");
  head.className = "card-head";
  const h = document.createElement("h2");
  h.className = "chat-name";
  h.textContent = String(group.name ?? "Chat");
  head.append(h);
  if (group.running) head.append(badge(`${group.running} running`, "run"));
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
api.onState((next) => {
  state = next;
  render();
});
api.getState().then((next) => {
  state = next;
  render();
});
