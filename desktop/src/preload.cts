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
  attach: (path: string, nativeSessionId: string | null, title: string | null) =>
    ipcRenderer.invoke("conversation:attach", path, nativeSessionId, title),
  detach: (path: string, localBindingRef: string) =>
    ipcRenderer.invoke("conversation:detach", path, localBindingRef),
  decideLink: (linkId: string, approve: boolean) =>
    ipcRenderer.invoke("link:decide", linkId, approve),
  attachForLink: (linkId: string) => ipcRenderer.invoke("link:attach", linkId),
  setPaused: (paused: boolean) => ipcRenderer.invoke("runtime:pause", paused),
  restart: () => ipcRenderer.invoke("runtime:restart"),
  openDashboard: () => ipcRenderer.invoke("open:dashboard"),
  openExternal: (url: string) => ipcRenderer.invoke("open:external", url),
  setSettings: (patch: { autoStart?: boolean; notifications?: boolean }) =>
    ipcRenderer.invoke("settings:set", patch),
};

contextBridge.exposeInMainWorld("threadlink", api);
