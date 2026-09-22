import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Local storage for the bridge's ThreadLink connection credential.
 *
 * - Windows: DPAPI (CurrentUser) via PowerShell ConvertFrom-SecureString; only
 *   the encrypted blob is written to disk, readable only by this Windows user.
 * - macOS: login Keychain via `security`.
 * - Linux: Secret Service via `secret-tool` when available.
 * - Fallback: THREADLINK_BRIDGE_TOKEN environment variable (Alpha; warned).
 *
 * The token is passed to helper processes on stdin, never on the command line
 * (except macOS `security`, see docs), and is never logged.
 */

export const TOKEN_PATTERN = /^tlc_[A-Za-z0-9_-]{43}$/;
export const ENV_TOKEN = "THREADLINK_BRIDGE_TOKEN";

export type RunResult = { code: number; stdout: string; stderr: string };
export type Runner = (command: string, args: string[], stdin?: string) => Promise<RunResult>;

export const defaultRunner: Runner = (command, args, stdin) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(stdin ?? "");
  });

export type CredentialStore = {
  readonly description: string;
  load(): Promise<string | null>;
  save(token: string): Promise<void>;
  clear(): Promise<void>;
};

const PS = ["-NoProfile", "-NonInteractive", "-Command"];
const PS_PROTECT =
  "$t = [Console]::In.ReadToEnd(); ConvertTo-SecureString -String $t -AsPlainText -Force | ConvertFrom-SecureString";
const PS_UNPROTECT =
  "$e = [Console]::In.ReadToEnd().Trim(); $s = ConvertTo-SecureString -String $e; " +
  "$b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); " +
  "try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)) } " +
  "finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }";

function assertToken(token: string): void {
  if (!TOKEN_PATTERN.test(token))
    throw new Error("That is not a ThreadLink connection credential (tlc_...).");
}

export function windowsDpapiStore(configDir: string, run: Runner = defaultRunner): CredentialStore {
  const file = join(configDir, "credential.dpapi");
  return {
    description: `Windows DPAPI (current user), ${file}`,
    async load() {
      let blob: string;
      try {
        blob = (await readFile(file, "utf8")).trim();
      } catch {
        return null;
      }
      const res = await run("powershell.exe", [...PS, PS_UNPROTECT], blob);
      if (res.code !== 0) throw new Error("Could not decrypt the stored credential (DPAPI).");
      const token = res.stdout.trim();
      return TOKEN_PATTERN.test(token) ? token : null;
    },
    async save(token) {
      assertToken(token);
      const res = await run("powershell.exe", [...PS, PS_PROTECT], token);
      if (res.code !== 0 || !res.stdout.trim())
        throw new Error("Could not encrypt the credential (DPAPI).");
      await mkdir(configDir, { recursive: true });
      await writeFile(file, res.stdout.trim(), { encoding: "utf8", mode: 0o600 });
    },
    async clear() {
      await rm(file, { force: true });
    },
  };
}

export function macKeychainStore(run: Runner = defaultRunner): CredentialStore {
  const base = ["-a", "threadlink-bridge", "-s", "ThreadLink bridge credential"];
  return {
    description: "macOS login Keychain",
    async load() {
      const res = await run("security", ["find-generic-password", ...base, "-w"]);
      const token = res.stdout.trim();
      return res.code === 0 && TOKEN_PATTERN.test(token) ? token : null;
    },
    async save(token) {
      assertToken(token);
      // `security -i` reads the command from stdin so the token never appears in argv
      // (visible to other local processes). The token charset is base64url: no quoting issues.
      const res = await run(
        "security",
        ["-i"],
        `add-generic-password -a threadlink-bridge -s "ThreadLink bridge credential" -U -w ${token}
`,
      );
      if (res.code !== 0) throw new Error("Could not store the credential in the Keychain.");
    },
    async clear() {
      await run("security", ["delete-generic-password", ...base]);
    },
  };
}

export function linuxSecretToolStore(run: Runner = defaultRunner): CredentialStore {
  const attrs = ["service", "threadlink-bridge"];
  return {
    description: "Secret Service (secret-tool)",
    async load() {
      const res = await run("secret-tool", ["lookup", ...attrs]).catch(() => null);
      const token = res?.stdout.trim() ?? "";
      return res?.code === 0 && TOKEN_PATTERN.test(token) ? token : null;
    },
    async save(token) {
      assertToken(token);
      const res = await run(
        "secret-tool",
        ["store", "--label=ThreadLink bridge", ...attrs],
        token,
      ).catch(() => null);
      if (!res || res.code !== 0) {
        throw new Error(`secret-tool is unavailable; set ${ENV_TOKEN} instead (see docs).`);
      }
    },
    async clear() {
      await run("secret-tool", ["clear", ...attrs]).catch(() => null);
    },
  };
}

/**
 * Last-resort store for headless environments (containers, SSH hosts, cloud VMs)
 * that have no OS keyring: a 0600 file in the private config directory, like
 * other CLIs do. Used ONLY when the keyring is unavailable, and the Runtime says
 * so, because anything that can read the file can use the credential.
 */
export function fileStore(configDir: string): CredentialStore {
  const file = join(configDir, "credential");
  return {
    description: "a protected file (no OS keychain on this machine)",
    async load() {
      try {
        const token = (await readFile(file, "utf8")).trim();
        return TOKEN_PATTERN.test(token) ? token : null;
      } catch {
        return null;
      }
    },
    async save(token) {
      assertToken(token);
      await mkdir(configDir, { recursive: true, mode: 0o700 });
      await writeFile(file, token, { encoding: "utf8", mode: 0o600 });
      await chmod(file, 0o600).catch(() => {});
    },
    async clear() {
      await rm(file, { force: true });
    },
  };
}

/** Prefers the OS keyring; falls back to the protected file when it is missing. */
export function withFallback(primary: CredentialStore, fallback: CredentialStore): CredentialStore {
  let usingFallback = false;
  return {
    get description() {
      return usingFallback ? fallback.description : primary.description;
    },
    async load() {
      const fromPrimary = await primary.load().catch(() => null);
      if (fromPrimary) return fromPrimary;
      const fromFallback = await fallback.load();
      usingFallback = Boolean(fromFallback);
      return fromFallback;
    },
    async save(token) {
      try {
        await primary.save(token);
        usingFallback = false;
      } catch {
        await fallback.save(token);
        usingFallback = true;
      }
    },
    async clear() {
      await primary.clear().catch(() => {});
      await fallback.clear();
    },
  };
}

export function createCredentialStore(options: {
  configDir: string;
  platform?: NodeJS.Platform;
  run?: Runner;
}): CredentialStore {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return windowsDpapiStore(options.configDir, options.run);
  if (platform === "darwin") return macKeychainStore(options.run);
  return withFallback(linuxSecretToolStore(options.run), fileStore(options.configDir));
}

/** Environment override first (Alpha fallback), then the OS store. */
export async function loadToken(
  store: CredentialStore,
  env: Record<string, string | undefined> = process.env,
): Promise<{ token: string; source: "env" | "store" } | null> {
  const fromEnv = env[ENV_TOKEN]?.trim();
  if (fromEnv) {
    assertToken(fromEnv);
    return { token: fromEnv, source: "env" };
  }
  const stored = await store.load();
  return stored ? { token: stored, source: "store" } : null;
}
