import { describe, expect, it } from "vitest";

import { buildAgentEnv, isScrubbedVariable } from "../../runtime/src/team/env.ts";

const MUST_REMOVE = [
  // named in the design / brief
  "ANTHROPIC_API_KEY",
  // ThreadLink's own credential and settings (0.10 security review)
  "THREADLINK_BRIDGE_TOKEN",
  "THREADLINK_CODEX_PATH",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "CODEX_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_DEPLOYMENT",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "AWS_BEARER_TOKEN_BEDROCK",
  // families
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "OPENAI_ORG_ID",
  "CLAUDE_CODE_USE_SOMETHING_NEW",
  "GEMINI_API_KEY",
  "SOME_SERVICE_API_KEY",
  "MY_AUTH_TOKEN",
  // parent Claude Code session linkage
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_HOST_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "CLAUDE_CODE_SESSION_ATTENDED",
];

const MUST_KEEP = [
  "PATH",
  "Path",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "SystemRoot",
  "TEMP",
  "TMP",
  "CODEX_HOME",
  "LANG",
  "NODE_ENV",
  "GIT_AUTHOR_NAME",
  "CLAUDE_CODE_GIT_BASH_PATH",
  "CLAUDE_CODE_OAUTH_TOKEN", // subscription login for headless setups: not a billing switch
  "API_KEY_HINT", // does not END in _API_KEY
  "TOKEN_DIR",
  "ANTHROPICISH", // no underscore: not the ANTHROPIC_ family
  "MY_OPENAI_NOTES", // does not start with OPENAI_
];

describe("buildAgentEnv", () => {
  it("removes every billing-switching, key-bearing or parent-session variable", () => {
    for (const name of MUST_REMOVE) expect(isScrubbedVariable(name), name).toBe(true);
    const parent = Object.fromEntries(MUST_REMOVE.map((k) => [k, `value-of-${k}`]));
    const { env, removed } = buildAgentEnv(parent);
    expect(env).toEqual({});
    expect(removed).toEqual([...MUST_REMOVE].sort());
  });

  it("keeps ordinary variables with their values", () => {
    for (const name of MUST_KEEP) expect(isScrubbedVariable(name), name).toBe(false);
    const parent = Object.fromEntries(MUST_KEEP.map((k) => [k, `v-${k}`]));
    const { env, removed } = buildAgentEnv(parent);
    expect(env).toEqual(parent);
    expect(removed).toEqual([]);
  });

  it("matches case-insensitively (Windows variable names are case-insensitive)", () => {
    const { env, removed } = buildAgentEnv({
      anthropic_api_key: "a",
      OpenAI_Api_Key: "b",
      claudecode: "1",
      azure_openai_endpoint: "c",
      path: "/bin",
    });
    expect(env).toEqual({ path: "/bin" });
    expect(removed).toHaveLength(4);
  });

  it("reports names only, never values, and does not mutate the parent", () => {
    const parent = { ANTHROPIC_API_KEY: "sk-ant-SECRET", PATH: "/usr/bin" };
    const { env, removed } = buildAgentEnv(parent);
    expect(JSON.stringify(removed)).not.toContain("SECRET");
    expect(parent).toEqual({ ANTHROPIC_API_KEY: "sk-ant-SECRET", PATH: "/usr/bin" });
    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  it("drops undefined values and defaults to process.env", () => {
    expect(buildAgentEnv({ A: undefined, B: "x" }).env).toEqual({ B: "x" });
    const fromProcess = buildAgentEnv();
    for (const name of Object.keys(fromProcess.env)) {
      expect(isScrubbedVariable(name)).toBe(false);
    }
  });
});
