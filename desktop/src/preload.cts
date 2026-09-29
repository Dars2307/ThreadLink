/**
 * The only bridge between the sandboxed renderer and the main process.
 * Narrow, fixed channel list; no credential or Node API is ever exposed.
 * (CommonJS: Electron preload scripts in sandboxed renderers must be CJS.)
 */
const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

const api = {
  getState: () => ipcRenderer.invoke("state:get"),
  onState: (cb: (state: unknown) => void) => {
    const listener = (_e: unknown, state: unknown) => cb(state);
    ipcRenderer.on("state", listener);
    return () => ipcRenderer.removeListener("state", listener);
  },
  signIn: (url: string) => ipcRenderer.invoke("signin:start", url),
  cancelSignIn: () => ipcRenderer.invoke("signin:cancel"),
  signOut: () => ipcRenderer.invoke("signout"),
  detectedWorkspaces: () => ipcRenderer.invoke("workspaces:detected"),
  addWorkspace: (path?: string) => ipcRenderer.invoke("workspace:add", path ?? null),
  listConversations: (path: string) => ipcRenderer.invoke("conversations:list", path),
  attach: (
    path: string,
    nativeSessionId: string | null,
    title: string | null,
    mode?: "worker" | "resume",
  ) => ipcRenderer.invoke("conversation:attach", path, nativeSessionId, title, mode ?? "worker"),
  setMode: (path: string, localBindingRef: string, mode: "worker" | "resume") =>
    ipcRenderer.invoke("conversation:mode", path, localBindingRef, mode),
  detach: (path: string, localBindingRef: string) =>
    ipcRenderer.invoke("conversation:detach", path, localBindingRef),
  decideLink: (linkId: string, approve: boolean) =>
    ipcRenderer.invoke("link:decide", linkId, approve),
  attachForLink: (linkId: string) => ipcRenderer.invoke("link:attach", linkId),
  setPaused: (paused: boolean) => ipcRenderer.invoke("runtime:pause", paused),
  restart: () => ipcRenderer.invoke("runtime:restart"),
  openDashboard: () => ipcRenderer.invoke("open:dashboard"),
  openExternal: (url: string) => ipcRenderer.invoke("open:external", url),
  getPlans: () => ipcRenderer.invoke("plans:get"),
  setPlan: (provider: string, plan: string) => ipcRenderer.invoke("plans:set", provider, plan),
  checkProviders: (provider?: string) => ipcRenderer.invoke("providers:check", provider ?? null),
  setSettings: (patch: {
    autoStart?: boolean;
    notifications?: boolean;
    theme?: "system" | "light" | "dark";
    backdrop?: "aurora" | "dusk" | "grid" | "none";
    animate?: boolean;
  }) => ipcRenderer.invoke("settings:set", patch),
  // 0.10 chats: main validates every argument and rate-limits each operation.
  listChats: (groupBy?: "recent" | "project") =>
    ipcRenderer.invoke("chats:list", groupBy ?? "recent"),
  // 0.11: chats + projects + needs-you + failover preference in one call.
  chatsOverview: (groupBy?: "recent" | "project") =>
    ipcRenderer.invoke("chats:overview", groupBy ?? "recent"),
  createChat: (input: { name: string; roomId?: string | null; mode?: "solo" | "pair" | "team" }) =>
    ipcRenderer.invoke("chat:create", input),
  openChat: (chatId: string) => ipcRenderer.invoke("chat:open", chatId),
  chatEvents: (chatId: string, page?: { after?: number; before?: number }) =>
    ipcRenderer.invoke("chat:events", chatId, page ?? {}),
  sendChat: (
    chatId: string,
    body: string,
    idempotencyKey: string,
    lane?: "auto" | "chat" | "work",
  ) => ipcRenderer.invoke("chat:send", chatId, body, idempotencyKey, lane ?? "auto"),
  setFailover: (policy: "auto" | "ask" | "wait") => ipcRenderer.invoke("settings:failover", policy),
  answerChoice: (chatId: string, choiceId: string, option: string, idempotencyKey: string) =>
    ipcRenderer.invoke("chat:answer", chatId, choiceId, option, idempotencyKey),
  markChatRead: (chatId: string, seq: number) => ipcRenderer.invoke("chat:read", chatId, seq),
  openLogs: () => ipcRenderer.invoke("open:logs"),
};

contextBridge.exposeInMainWorld("threadlink", api);
