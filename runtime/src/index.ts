/**
 * ThreadLink Runtime public API. The CLI (`threadlink`) and the desktop app
 * both build on this module, so they behave identically.
 */
import { defaultAdapters } from "./adapters/index.ts";
import type { ProviderAdapter } from "./adapters/types.ts";
import {
  ApiError,
  pollDeviceToken,
  startDeviceLogin,
  ThreadLinkApi,
  validateBaseUrl,
} from "./api.ts";
import type { DeviceStart } from "./api.ts";
import {
  createCredentialStore,
  loadToken,
  TOKEN_PATTERN,
  type CredentialStore,
} from "./credentials.ts";
import { RuntimeEngine } from "./engine.ts";
import type { EngineOptions } from "./engine.ts";
import { detectIdentity, type RuntimeKind } from "./platform.ts";
import { canonicalizeBaseUrl } from "./endpoints.ts";
import { defaultConfigDir, loadConfig, saveConfig } from "./state.ts";

export { ApiError, ThreadLinkApi, validateBaseUrl } from "./api.ts";
export type { DeviceStart, LinkView, RuntimeView } from "./api.ts";
export { ClaudeCodeAdapter, UnavailableAdapter, defaultAdapters } from "./adapters/index.ts";
export type * from "./adapters/types.ts";
export { RuntimeEngine } from "./engine.ts";
export type * from "./engine.ts";
export { detectIdentity, remoteEnvironment, runtimePlatform } from "./platform.ts";
export type * from "./platform.ts";
export { defaultConfigDir, loadConfig, migrateBaseUrl, saveConfig } from "./state.ts";
export {
  BUILD_CHANNEL,
  CANONICAL_BASE_URL,
  canonicalBaseUrl,
  canonicalizeBaseUrl,
  isGeneratedDeploymentHost,
} from "./endpoints.ts";
export type { CanonicalizeResult, ThreadLinkChannel } from "./endpoints.ts";
export { maskSessionId } from "./claude-sessions.ts";

export const RUNTIME_VERSION = "0.6.6";

export type RuntimeContext = {
  configDir: string;
  store: CredentialStore;
};

export function runtimeContext(configDir = defaultConfigDir()): RuntimeContext {
  return { configDir, store: createCredentialStore({ configDir }) };
}

export async function storedBaseUrl(ctx: RuntimeContext): Promise<string | null> {
  const raw = process.env.THREADLINK_URL ?? (await loadConfig(ctx.configDir)).baseUrl;
  if (!raw) return null;
  // A generated deployment hostname is an old build frozen in time: upgrade it.
  return validateBaseUrl(canonicalizeBaseUrl(raw).url);
}

/**
 * Browser sign-in (device authorization). `onCode` shows the code/URL to the
 * user; `confirmAccount` lets the UI confirm which account approved it before
 * the credential is stored. Returns false if the user declined.
 */
export async function signIn(
  ctx: RuntimeContext,
  baseUrl: string,
  deviceName: string,
  hooks: {
    onCode: (start: DeviceStart) => void | Promise<void>;
    confirmAccount?: (accountHint: string | null) => Promise<boolean>;
    signal?: AbortSignal;
  },
): Promise<boolean> {
  const url = validateBaseUrl(baseUrl);
  const start = await startDeviceLogin(url, deviceName.slice(0, 100));
  await hooks.onCode(start);
  const token = await pollDeviceToken(url, start, { signal: hooks.signal });
  if (!TOKEN_PATTERN.test(token.access_token)) throw new Error("Unexpected credential format.");
  const who = await new ThreadLinkApi({ baseUrl: url, token: token.access_token }).whoami();
  if (who.role !== "agent") throw new Error("ThreadLink did not issue a Runtime credential.");
  if (hooks.confirmAccount && !(await hooks.confirmAccount(token.account_hint))) return false;
  await ctx.store.save(token.access_token);
  await saveConfig(ctx.configDir, { baseUrl: url });
  return true;
}

export async function signOut(ctx: RuntimeContext): Promise<void> {
  await ctx.store.clear();
}

/** The signed-in API client, or null if there is no valid stored credential. */
export async function signedInApi(ctx: RuntimeContext): Promise<ThreadLinkApi | null> {
  const baseUrl = await storedBaseUrl(ctx);
  const loaded = await loadToken(ctx.store).catch(() => null);
  if (!baseUrl || !loaded) return null;
  const api = new ThreadLinkApi({ baseUrl, token: loaded.token });
  try {
    const who = await api.whoami();
    return who.role === "agent" ? api : null;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

export function createEngine(
  ctx: RuntimeContext,
  api: ThreadLinkApi,
  options: Partial<Omit<EngineOptions, "api" | "configDir">> & {
    kind?: RuntimeKind;
    label?: string;
  } = {},
): RuntimeEngine {
  const { kind, label, adapters, identity, ...rest } = options;
  return new RuntimeEngine({
    api,
    configDir: ctx.configDir,
    adapters: adapters ?? (defaultAdapters() as ProviderAdapter[]),
    identity: identity ?? detectIdentity({ kind, label }),
    version: RUNTIME_VERSION,
    ...rest,
  });
}
