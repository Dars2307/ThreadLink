/* ThreadLink desktop renderer: sandboxed, no Node APIs, talks only through window.threadlink. */
const api = window.threadlink;
const view = document.getElementById("view");
let state = null;
let selectedWorkspace = null;
/** Link decisions in flight, so a re-render cannot resend one. */
const decided = new Set();

const el = (id) => document.getElementById(id);
const tpl = (name) => document.getElementById(`tpl-${name}`).content.cloneNode(true);

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

function statusOf(s) {
  if (!s.signedIn) return { title: "Not connected", tone: "warn", detail: "" };
  const snap = s.snapshot;
  const attached = (snap?.workspaces ?? []).flatMap((w) => w.conversations);
  if (snap?.status === "online" && attached.length) {
    const busy = attached.some((c) => c.busy);
    return {
      title: busy ? "Claude conversation in use" : "Ready",
      tone: busy ? "busy" : "ready",
      detail: `${attached.length} conversation${attached.length === 1 ? "" : "s"} attached`,
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

function render() {
  if (!state) return;
  const status = statusOf(state);
  el("status-title").textContent = status.title;
  el("status-dot").className = `dot ${status.tone}`;
  el("footer-detail").textContent = state.error ?? state.notice ?? status.detail ?? "";

  view.replaceChildren();
  if (state.pendingSignIn) return renderWaiting();
  const why = attention(state);
  if (why) return renderReconnect(why);
  if (!state.signedIn) return renderSignIn();
  const attached = (state.snapshot?.workspaces ?? []).flatMap((w) => w.conversations);
  return attached.length ? renderReady() : renderSetup();
}

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

async function renderSetup() {
  view.append(tpl("setup"));
  const claude = (state.snapshot?.providers ?? []).find((p) => p.id === "claude-code");
  el("claude-detect").textContent = claude?.available
    ? `Detected Claude Code ${claude.version ?? ""}`.trim()
    : "Claude Code was not found. Install it, then restart ThreadLink.";

  const detected = await api.detectedWorkspaces();
  const known = (state.snapshot?.workspaces ?? []).map((w) => ({ path: w.path, lastUsedAt: null }));
  const all = [
    ...known,
    ...detected.filter((d) => !known.some((k) => k.path.toLowerCase() === d.path.toLowerCase())),
  ];
  selectedWorkspace = selectedWorkspace ?? all[0]?.path ?? null;

  const list = el("workspace-list");
  list.replaceChildren();
  if (!all.length)
    list.append(
      row("No project folders found yet", "Open Claude Code in a folder, or choose one."),
    );
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
  const conversations = await api.listConversations(selectedWorkspace);
  const cl = el("conversation-list");
  cl.replaceChildren();
  if (!conversations.length) {
    cl.append(
      row(
        "No Claude conversations in this folder yet",
        "Start one in Claude Code, or choose the option below.",
      ),
    );
  }
  for (const c of conversations) {
    const item = row(
      c.title ?? "Untitled conversation",
      `Used ${ago(c.lastUsedAt)} · ${c.runtime}`,
      c.attached ? "Attached" : "Attach",
      c.busy ? "In use now" : null,
    );
    const button = item.querySelector("button");
    button.disabled = c.attached;
    button.addEventListener("click", async () => {
      button.disabled = true;
      await api.attach(selectedWorkspace, c.nativeSessionId, c.title);
    });
    cl.append(item);
  }
  el("attach-fresh").addEventListener("click", () => api.attach(selectedWorkspace, null, null));
}

function renderReady() {
  view.append(tpl("ready"));
  const snap = state.snapshot;
  el("mcp-url").textContent = `${state.baseUrl}/mcp`;
  el("copy-mcp").addEventListener("click", async () => {
    await navigator.clipboard.writeText(`${state.baseUrl}/mcp`);
    el("copy-mcp").textContent = "Copied";
    setTimeout(() => (el("copy-mcp").textContent = "Copy"), 1500);
  });

  const links = el("links");
  links.replaceChildren();
  for (const link of snap?.pendingLinks ?? []) {
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
    card.append(h, p, buttons, problem);
    links.append(card);
  }

  const attached = el("attached");
  attached.replaceChildren();
  for (const w of snap?.workspaces ?? []) {
    for (const c of w.conversations) {
      const item = row(
        c.title,
        `${w.name}${c.mode === "fresh" ? " · new conversation each request" : ""}`,
        "Detach",
        c.busy ? "In use now" : "Ready",
      );
      item
        .querySelector("button")
        .addEventListener("click", () => api.detach(w.path, c.localBindingRef));
      attached.append(item);
    }
  }
  el("add-more").addEventListener("click", () => {
    selectedWorkspace = null;
    view.replaceChildren();
    void renderSetup();
  });

  el("runtime-detail").textContent =
    `${snap?.runtime?.label ?? snap?.identity.label} · ${snap?.identity.platform} · ${
      snap?.lastHeartbeatAt ? `last check-in ${ago(snap.lastHeartbeatAt)}` : "connecting"
    }`;
  const pause = el("pause");
  pause.textContent = state.localPaused || snap?.runtime?.paused ? "Resume" : "Pause";
  pause.addEventListener("click", () =>
    api.setPaused(!(state.localPaused || snap?.runtime?.paused)),
  );
  el("restart").addEventListener("click", () => api.restart());
  el("signout").addEventListener("click", () => api.signOut());
  el("set-autostart").checked = state.settings.autoStart;
  el("set-autostart").addEventListener("change", (e) =>
    api.setSettings({ autoStart: e.target.checked }),
  );
  el("set-notifications").checked = state.settings.notifications;
  el("set-notifications").addEventListener("change", (e) =>
    api.setSettings({ notifications: e.target.checked }),
  );
}

function row(title, meta, actionLabel, badge) {
  const item = document.createElement("div");
  item.className = "item";
  const left = document.createElement("div");
  const t = document.createElement("div");
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
