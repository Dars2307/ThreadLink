// Test double for the Claude Code CLI as used by Team Mode (2.1.266 shapes):
//   claude --version
//   claude auth status --json     -> includes email/orgId/orgName (must be dropped)
//   claude -p ... --output-format json --model <m>   (prompt on stdin, read to EOF)
// It REFUSES (exit 64) any forbidden flag. Alias behaviour mirrors what was verified:
// `sonnet` and (wrongly) `haiku` both run claude-sonnet-5.
//
// FAKE_CT_MODE: ok | side_model | wrong_model | no_model_usage | quota | unauth |
//               oauth_refresh | oauth_stderr |
//               denials | structured | structured_fenced | structured_bad | hang | garbage
// FAKE_CT_AUTH: max (default) | none
// FAKE_PID_FILE: in hang mode, "<pid> <grandchildPid>" is written here.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const SENSITIVE = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "AWS_BEARER_TOKEN_BEDROCK",
  "SOME_SERVICE_API_KEY",
  "CLAUDECODE",
];
const FORBIDDEN = [
  "--bare",
  "--fallback-model",
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
];

const argv = process.argv.slice(2);
const mode = process.env.FAKE_CT_MODE ?? "ok";

if (argv[0] === "--version") {
  process.stdout.write("2.1.266 (Claude Code)\n");
  process.exit(0);
}
if (argv[0] === "auth" && argv[1] === "status") {
  const auth = process.env.FAKE_CT_AUTH ?? "max";
  const loggedIn = auth !== "none";
  process.stdout.write(
    JSON.stringify({
      loggedIn,
      authMethod: loggedIn ? "claude.ai" : "none",
      apiProvider: "firstParty",
      email: "secret.person@example.com",
      orgId: "org-SECRET-0000",
      orgName: "Secret Org Name",
      subscriptionType: loggedIn ? auth : null,
    }),
  );
  process.exit(loggedIn ? 0 : 1);
}

for (const arg of argv) {
  if (FORBIDDEN.includes(arg.split("=")[0]) || arg === "bypassPermissions") {
    process.stderr.write(`fake-claude-team: FORBIDDEN flag ${arg}\n`);
    process.exit(64);
  }
}
if (!argv.includes("-p") || !argv.includes("--safe-mode")) {
  process.stderr.write("fake-claude-team: expected -p --safe-mode\n");
  process.exit(65);
}
const valueOf = (flag) => {
  const at = argv.indexOf(flag);
  return at >= 0 ? argv[at + 1] : null;
};
const requested = valueOf("--model");
const resumeId = valueOf("--resume");
const ALIASES = { sonnet: "claude-sonnet-5", haiku: "claude-sonnet-5" };

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  if (mode === "hang") {
    const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], {
      stdio: "ignore",
    });
    if (process.env.FAKE_PID_FILE) {
      writeFileSync(process.env.FAKE_PID_FILE, `${process.pid} ${grandchild.pid}`);
    }
    setTimeout(() => {}, 120_000);
    return;
  }
  if (mode === "garbage") {
    process.stderr.write("something broke\n");
    process.stdout.write("not json");
    process.exit(3);
  }
  const ran = mode === "wrong_model" ? "claude-other-model" : (ALIASES[requested] ?? requested);
  const modelUsage = mode === "no_model_usage" ? undefined : { [ran]: { outputTokens: 42 } };
  if (mode === "side_model") modelUsage["claude-haiku-4-5-20251001"] = { outputTokens: 3 };

  const seen = SENSITIVE.filter((k) => process.env[k] !== undefined);
  let result = `ok args=[${argv.join(" ")}] env=[${seen.join(",")}] stdinEOF=true projectRules=${input.includes("CLAUDE.md")} schemaInPrompt=${input.includes("JSON Schema")}`;
  let isError = false;
  let code = 0;
  if (mode === "quota") {
    result = "Claude AI usage limit reached|1760000000";
    isError = true;
    code = 1;
  }
  if (mode === "unauth") {
    result = "Not logged in · Please run /login";
    isError = true;
    code = 1;
  }
  if (mode === "oauth_refresh") {
    // Production, 0.8: `claude auth status` said loggedIn, and the run said this.
    result = "Failed to refresh OAuth token";
    isError = true;
    code = 1;
  }
  if (mode === "oauth_stderr") {
    process.stderr.write("Failed to refresh OAuth token: refresh token revoked\n");
    process.exit(1);
  }
  if (mode === "structured") result = '{"verdict":"PASS","findings":[]}';
  if (mode === "structured_fenced") result = '```json\n{"verdict":"NEEDS_FIX","findings":[1]}\n```';
  if (mode === "structured_bad") result = "I reviewed it and it looks fine.";

  process.stdout.write(
    JSON.stringify({
      type: "result",
      subtype: isError ? "error_during_execution" : "success",
      is_error: isError,
      result,
      session_id: resumeId ?? "22222222-3333-4444-8555-666666666666",
      modelUsage,
      permission_denials: mode === "denials" ? [{ tool_name: "Bash" }, { tool_name: "Edit" }] : [],
      usage: { input_tokens: 100, output_tokens: 42 },
      total_cost_usd: 0,
    }),
  );
  process.exit(code);
});
