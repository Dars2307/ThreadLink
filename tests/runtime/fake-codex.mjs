// Test double for the Codex CLI, shaped on verified 0.155 behaviour:
//   codex --version                       -> "codex-cli 0.155.0-alpha.16.4"
//   codex login status                    -> "Logged in using ChatGPT" (on stderr)
//   codex archive <id>
//   codex exec [resume <id>] --json ... <prompt | ->
// `exec` always reads stdin to EOF first, like the real CLI ("Reading additional input
// from stdin"), so a runner that leaves stdin open hangs here too.
//
// It REFUSES (exit 64) any forbidden flag, and (exit 65) a run without the mandatory
// explicit-access flags. It writes a rollout under $CODEX_HOME/sessions with
// session_meta / turn_context lines plus message lines holding a secret that must
// never surface in a runner result.
//
// Behaviour is chosen by FAKE_CODEX_MODE:
//   ok | wrong_model | wrong_sandbox | wrong_cwd | no_rollout | quota | unauth |
//   turn_failed | hang | structured | structured_bad | exit_nonzero | login_required
// FAKE_CODEX_AUTH: chatgpt (default) | apikey | none      (for `login status`)
// FAKE_PID_FILE: in hang mode, "<pid> <grandchildPid>" is written here.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const ROLLOUT_SECRET = "FAKE_ROLLOUT_SECRET_MESSAGE_CONTENT_7f3a";
const SENSITIVE = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "CODEX_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "CLAUDE_CODE_USE_BEDROCK",
  "SOME_SERVICE_API_KEY",
];
const FORBIDDEN = [
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust",
  "--oss",
  "--ephemeral",
  "--full-auto",
  "--yolo",
];

const argv = process.argv.slice(2);
const mode = process.env.FAKE_CODEX_MODE ?? "ok";

if (argv[0] === "--version") {
  process.stdout.write("codex-cli 0.155.0-alpha.16.4\n");
  process.exit(0);
}
if (argv[0] === "login" && argv[1] === "status") {
  const auth = process.env.FAKE_CODEX_AUTH ?? "chatgpt";
  if (auth === "none") {
    process.stderr.write("Not logged in\n");
    process.exit(1);
  }
  process.stderr.write(
    auth === "apikey" ? "Logged in using an API key - sk-***\n" : "Logged in using ChatGPT\n",
  );
  process.exit(0);
}
if (argv[0] === "archive") {
  process.stdout.write(`archived ${argv[1]}\n`);
  process.exit(0);
}
if (argv[0] !== "exec") {
  process.stderr.write(`fake-codex: unsupported command ${argv[0]}\n`);
  process.exit(2);
}

for (const arg of argv) {
  const flag = arg.split("=")[0];
  if (FORBIDDEN.includes(flag) || arg.includes("danger-full-access")) {
    process.stderr.write(`fake-codex: FORBIDDEN flag ${arg}\n`);
    process.exit(64);
  }
}

// --- parse -----------------------------------------------------------------------
const opts = { configs: [], positional: [] };
let i = 1;
let resumeId = null;
if (argv[1] === "resume") {
  resumeId = argv[2];
  i = 3;
}
const takesValue = new Set([
  "-c",
  "--config",
  "-m",
  "--model",
  "-s",
  "--sandbox",
  "-C",
  "--cd",
  "--output-schema",
  "-o",
  "--output-last-message",
]);
for (; i < argv.length; i++) {
  const a = argv[i];
  if (takesValue.has(a)) {
    const v = argv[++i];
    if (a === "-c" || a === "--config") opts.configs.push(v);
    else opts[a] = v;
  } else if (a.startsWith("-") && a !== "-") {
    opts[a] = true;
  } else {
    opts.positional.push(a);
  }
}
const config = (key) => {
  for (const c of opts.configs) {
    const m = new RegExp(`^${key}="?([^"]*)"?$`).exec(c);
    if (m) return m[1];
  }
  return null;
};
const model = opts["-m"] ?? opts["--model"];
const sandbox = resumeId ? config("sandbox_mode") : (opts["-s"] ?? opts["--sandbox"]);
const approval = config("approval_policy");
if (
  !opts["--json"] ||
  !opts["--ignore-user-config"] ||
  approval !== "never" ||
  !sandbox ||
  !model
) {
  process.stderr.write("fake-codex: missing mandatory explicit-access flags\n");
  process.exit(65);
}
if (resumeId && (opts["-s"] || opts["-C"])) {
  process.stderr.write("error: unexpected argument for 'codex exec resume'\n");
  process.exit(2);
}
const effort = config("model_reasoning_effort") ?? "medium";
const cwd = opts["-C"] ?? process.cwd();
const promptArg = opts.positional.at(-1);

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const home = process.env.CODEX_HOME;

function findRollout(id) {
  const root = join(home, "sessions");
  if (!existsSync(root)) return null;
  for (const y of readdirSync(root))
    for (const m of readdirSync(join(root, y)))
      for (const d of readdirSync(join(root, y, m))) {
        const hit = readdirSync(join(root, y, m, d)).find((n) => n.endsWith(`-${id}.jsonl`));
        if (hit) return join(root, y, m, d, hit);
      }
  return null;
}

let stdin = "";
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", () => {
  const prompt = promptArg === "-" ? stdin : promptArg;
  if (mode === "hang") {
    const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], {
      stdio: "ignore",
    });
    if (process.env.FAKE_PID_FILE)
      writeFileSync(process.env.FAKE_PID_FILE, `${process.pid} ${grandchild.pid}`);
    setTimeout(() => {}, 120_000);
    return;
  }

  let threadId = resumeId ?? randomUUID();
  let file = resumeId ? findRollout(resumeId) : null;
  if (resumeId && !file) {
    emit({ type: "error", message: `no rollout found for thread id ${resumeId}` });
    process.exit(1);
  }
  emit({ type: "thread.started", thread_id: threadId });
  emit({ type: "turn.started" });
  process.stdout.write("this line is not JSON and must be ignored\n");
  emit({ type: "some.future.event", detail: { x: 1 } });

  if (mode === "quota") {
    const message = "You've hit your usage limit. Upgrade to Pro or try again later.";
    emit({ type: "error", message });
    emit({ type: "turn.failed", error: { message } });
    process.exit(1);
  }
  if (mode === "unauth") {
    emit({ type: "error", message: "unexpected status 401 Unauthorized: please log in again" });
    emit({ type: "turn.failed", error: { message: "unexpected status 401 Unauthorized" } });
    process.exit(1);
  }
  if (mode === "login_required") {
    const message = "Not logged in. Please run `codex login` to sign in again.";
    emit({ type: "error", message });
    emit({ type: "turn.failed", error: { message } });
    process.exit(1);
  }
  if (mode === "turn_failed") {
    emit({ type: "turn.failed", error: { message: "stream disconnected before completion" } });
    process.exit(1);
  }

  // --- rollout: metadata lines + message lines holding a secret ---
  if (mode !== "no_rollout") {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const dir = join(
      home,
      "sessions",
      String(now.getFullYear()),
      pad(now.getMonth() + 1),
      pad(now.getDate()),
    );
    mkdirSync(dir, { recursive: true });
    if (!file)
      file = join(dir, `rollout-${now.toISOString().replace(/[:.]/g, "-")}-${threadId}.jsonl`);
    const line = (type, payload) =>
      appendFileSync(
        file,
        `${JSON.stringify({ timestamp: now.toISOString(), ordinal: 1, type, payload })}\n`,
      );
    if (!resumeId) {
      line("session_meta", {
        id: threadId,
        cwd,
        cli_version: "0.155.0-alpha.16.4",
        base_instructions: { text: `instructions ${ROLLOUT_SECRET}` },
      });
    }
    line("response_item", {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: `${prompt} ${ROLLOUT_SECRET} "type":"turn_context" model gpt-evil`,
        },
      ],
    });
    line("turn_context", {
      turn_id: randomUUID(),
      cwd: mode === "wrong_cwd" ? join(cwd, "..") : cwd,
      approval_policy: "never",
      sandbox_policy: {
        type:
          mode === "wrong_sandbox"
            ? sandbox === "read-only"
              ? "workspace-write"
              : "read-only"
            : sandbox,
      },
      model: mode === "wrong_model" ? "gpt-other-model" : model,
      effort,
    });
    line("event_msg", { type: "agent_message", message: `reply ${ROLLOUT_SECRET}` });
  }

  const seen = SENSITIVE.filter((k) => process.env[k] !== undefined);
  let text = `ok model=${model} sandbox=${sandbox} env=[${seen.join(",")}] codexHome=${home ? "set" : "unset"} stdinEOF=true viaStdin=${promptArg === "-"} promptLength=${prompt.length} rolePrompt=${prompt.startsWith("[ThreadLink Team Mode]")}`;
  if (mode === "structured" || mode === "structured_bad") {
    const schemaPath = opts["--output-schema"];
    const schema = schemaPath ? JSON.parse(readFileSync(schemaPath, "utf8")) : null;
    text =
      mode === "structured" && schema
        ? JSON.stringify({ verdict: "PASS", schemaTitle: schema.title ?? null })
        : "not json at all";
  }
  emit({ type: "item.completed", item: { id: "item_0", type: "reasoning", text: "thinking" } });
  emit({
    type: "item.completed",
    item: {
      id: "item_1",
      type: "command_execution",
      command: "ls",
      aggregated_output: "",
      exit_code: 0,
      status: "completed",
    },
  });
  emit({ type: "item.completed", item: { id: "item_2", type: "agent_message", text } });
  emit({
    type: "turn.completed",
    usage: {
      input_tokens: 120,
      cached_input_tokens: 20,
      output_tokens: 7,
      reasoning_output_tokens: 3,
    },
  });
  process.exit(mode === "exit_nonzero" ? 1 : 0);
});
