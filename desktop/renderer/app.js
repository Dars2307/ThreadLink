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

const el = (id) => document.getElementById(id);
const tpl = (name) => document.getElementById(`tpl-${name}`).content.cloneNode(true);

const SECTIONS = [
  { id: "home", label: "Home", title: "Home" },
  { id: "conversations", label: "Conversations", title: "Conversations" },
  { id: "runtime", label: "Runtime", title: "Runtime" },
  { id: "notifications", label: "Notifications", title: "Notifications" },
  { id: "settings", label: "Settings", title: "Settings" },
];

const MODES = {
  worker: {
    name: "Background worker",
    why: "Works while Claude Code is open. Uses a separate ThreadLink worker in the same project.",
  },
  resume: {
    name: "Exact conversation",
    why: "Resumes this exact Claude conversation. It must not already be open.",
  },
  fresh: {
    name: "New conversation each time",
    why: "Starts a fresh Claude conversation for every request.",
  },
};

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
  if (section === "conversations") return renderConversations();
  if (section === "runtime") return renderRuntime();
  if (section === "notifications") return renderNotifications();
  if (section === "settings") return renderSettings();
  return renderHome();
}

function subtitleFor() {
  const snap = state.snapshot;
  if (section === "home") return snap?.runtime?.label ?? snap?.identity?.label ?? "";
  if (section === "conversations") {
    const n = conversationsOf(state).length;
    return n ? `${n} attached` : "Nothing attached yet";
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
    const here = s.id === section || (section === "attach" && s.id === "conversations");
    button.setAttribute("aria-current", here ? "true" : "false");
    button.addEventListener("click", () => {
      section = s.id;
      changing = null;
      render();
    });
    nav.append(button);
  }
}

function go(next) {
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

  const status = statusOf(state);
  kv(el("home-status"), [
    ["Connection", status.title],
    ["This computer", snap?.runtime?.label ?? snap?.identity?.label ?? "—"],
    [
      "Project folders",
      (snap?.workspaces ?? []).map((w) => w.name).join(", ") || "None chosen yet",
    ],
  ]);

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
      emptyText: "No activity yet. When a task runs, what it did shows up here.",
    }),
  );
  el("home-activity-dashboard").addEventListener("click", () => api.openDashboard());

  el("home-manage").addEventListener("click", () => go("conversations"));
  el("mcp-url").textContent = `${state.baseUrl}/mcp`;
  el("copy-mcp").addEventListener("click", async () => {
    await navigator.clipboard.writeText(`${state.baseUrl}/mcp`);
    el("copy-mcp").textContent = "Copied";
    setTimeout(() => (el("copy-mcp").textContent = "Copy"), 1500);
  });
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

function renderConversations() {
  view.append(tpl("conversations"));
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

/** The two real execution modes, as a radio group. Background is the default. */
function modePicker(current, onChange) {
  const claude = (state.snapshot?.providers ?? []).find((p) => p.id === "claude-code");
  const available = {
    worker: claude?.supportsBackgroundWorker !== false,
    resume: claude?.supportsExactResume !== false,
  };
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
    why.textContent = available[id]
      ? MODES[id].why
      : `${claude?.name ?? "This app"} cannot do this on this computer.`;
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
  el("attach-back").addEventListener("click", () => go("conversations"));
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
  el("conversation-card").hidden = false;
  // Re-render on change: which conversations are worth warning about depends
  // on the mode, and a stale warning is what this whole change is about.
  el("attach-mode").replaceChildren(
    modePicker(attachMode, (next) => {
      attachMode = next;
      render();
    }),
  );

  el("conversation-pick").hidden = false;
  const problem = el("attach-problem");
  problem.hidden = true;
  const conversations = await api.listConversations(selectedWorkspace);
  if (superseded()) return;
  const cl = el("conversation-list");
  cl.replaceChildren();
  if (!conversations.length) {
    cl.append(empty("No Claude conversations in this folder yet. Start one in Claude Code."));
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
      go("conversations");
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
    go("conversations");
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
        w.exists ? w.path : `${w.path} — folder missing`,
        null,
        `${w.conversations.length} attached`,
      ),
    );
  }

  kv(el("runtime-advanced"), [
    ["ThreadLink address", state.baseUrl ?? "—"],
    ["Runtime ID", snap?.runtime?.runtimeId ?? "—"],
    ...(snap?.workspaces ?? []).flatMap((w) =>
      w.conversations.map((c) => [
        `${w.name} · ${c.title}`,
        `${c.mode}${c.nativeSessionId ? ` · ${c.nativeSessionId}` : ""}${
          c.workerNativeSessionId ? ` · worker ${c.workerNativeSessionId}` : ""
        }`,
      ]),
    ),
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
  kv(el("settings-advanced"), [
    ["ThreadLink address", state.baseUrl ?? "—"],
    ["Connector URL", `${state.baseUrl}/mcp`],
    ["This computer", state.snapshot?.identity?.kind ?? "—"],
  ]);
  el("signout").addEventListener("click", () => api.signOut());
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
  fresh: "Running in a new Claude conversation",
};

/** How many lines one conversation shows before the dashboard takes over. */
const FEED_LIMIT = 6;

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
function activityList(entries, { withConversation = false, emptyText } = {}) {
  const list = document.createElement("div");
  list.className = "activity-list";
  if (!entries.length) {
    list.append(empty(emptyText));
    return list;
  }
  for (const entry of entries.slice(0, FEED_LIMIT)) {
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
      emptyText: "Nothing has run here yet. Send a task from ChatGPT and it will show up here.",
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
