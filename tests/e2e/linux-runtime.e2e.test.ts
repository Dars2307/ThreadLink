import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { provisionThreadLinkUser } from "@/lib/auth/provision";

import { admin, identity, uniqueClerkId, userClient } from "../integration/helpers";

/**
 * OPT-IN (needs Docker): proves a headless Linux Runtime - an SSH host, cloud VM,
 * container or Codespace - can sign in and register with no desktop and no
 * credential copying. The container reaches this machine's dev server by mapping
 * localhost to the host gateway, so the Runtime still refuses plain http to a
 * remote address.
 *
 *   THREADLINK_DOCKER=1 npx vitest run --config vitest.e2e.config.mts tests/e2e/linux-runtime.e2e.test.ts
 */
const RUN = process.env.THREADLINK_DOCKER === "1";
const BASE_URL = process.env.THREADLINK_E2E_BASE_URL ?? "http://localhost:3200";
const A = uniqueClerkId("E2ELinux");

let ownerDb: Awaited<ReturnType<typeof userClient>>;
let packDir: string;

beforeAll(async () => {
  if (!RUN) return;
  ownerDb = await userClient(A);
  await provisionThreadLinkUser(identity(A), { displayName: null, primaryEmail: null }, ownerDb);
  packDir = mkdtempSync(join(tmpdir(), "tl-pack-"));
  const pack = spawnSync("npm", ["pack", "--pack-destination", packDir], {
    cwd: resolve(import.meta.dirname, "..", "..", "runtime"),
    encoding: "utf8",
    shell: true,
  });
  if (pack.status !== 0) throw new Error(`npm pack failed: ${pack.stderr}`);
}, 300_000);

afterAll(async () => {
  if (!RUN) return;
  rmSync(packDir, { recursive: true, force: true });
  await admin.from("users").delete().eq("clerk_user_id", A);
});

describe.runIf(RUN)("headless Linux Runtime", { timeout: 600_000 }, () => {
  it("signs in with a device code and registers itself", async () => {
    const port = new URL(BASE_URL).port || "80";
    const child = spawn(
      "docker",
      [
        "run",
        "--rm",
        "-i",
        "--add-host",
        "localhost:host-gateway",
        "-v",
        `${packDir}:/pkg:ro`,
        "-e",
        "HOSTNAME=cloud-dev-vm",
        "node:22-slim",
        "bash",
        "-lc",
        `npm i -g /pkg/threadlink-*.tgz >/dev/null 2>&1 && threadlink setup --url http://localhost:${port} --yes`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let out = "";
    let approved = false;
    const done = new Promise<number>((resolveExit) => {
      child.stdout.on("data", async (d: Buffer) => {
        out += d.toString("utf8");
        const code = /Code: ([BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4})/.exec(out)?.[1];
        if (code && !approved) {
          approved = true;
          // The human approves in the browser; here the owner approves directly.
          await ownerDb.rpc("decide_device_authorization", {
            p_user_code: code.replace("-", ""),
            p_approve: true,
          });
        }
      });
      child.stderr.on("data", (d: Buffer) => (out += d.toString("utf8")));
      child.on("close", (exitCode) => resolveExit(exitCode ?? 1));
    });

    const exitCode = await done;
    if (process.env.THREADLINK_DEBUG) console.log("CONTAINER OUTPUT:", out);
    expect(out).toMatch(/Approve this computer in your browser/);
    expect(out).toMatch(/Signed in/);
    expect(exitCode).toBe(0);

    const { data } = await ownerDb
      .from("runtimes")
      .select("label, platform, kind, capabilities, status")
      .eq("owner_user_id", (await ownerDb.from("users").select("id").single()).data!.id);
    expect(data).toHaveLength(1);
    expect(data![0]).toMatchObject({
      platform: "linux",
      kind: "cli",
      status: "active",
      // No Claude Code in the container: ThreadLink will not route work here.
      capabilities: expect.objectContaining({ "claude-code": "unavailable", filesystem: "local" }),
    });
    expect(out).toMatch(/Claude Code was not found/);
  });
});
