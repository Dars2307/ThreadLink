// Test double for the Claude Code CLI, shaped on verified 2.1.x behaviour:
//   claude -p [--resume <id> | --continue] --output-format json ...   (prompt on stdin)
//   claude agents --json
// Behaviour is chosen by env vars. With FAKE_CLAUDE_STATE set, sessions persist in
// that directory so resumed sessions "remember" earlier turns (context retention).
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const stateDir = process.env.FAKE_CLAUDE_STATE;

if (argv[0] === "agents") {
  if (process.env.FAKE_CLAUDE_AGENTS_FAIL) process.exit(2);
  const running = (process.env.FAKE_CLAUDE_RUNNING ?? "").split(",").filter(Boolean);
  process.stdout.write(
    JSON.stringify(
      running.map((sessionId, i) => ({
        pid: 1000 + i,
        sessionId,
        kind: "interactive",
        status: "idle",
      })),
    ),
  );
  process.exit(0);
}

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const mode = process.env.FAKE_CLAUDE_MODE ?? "ok";
  if (mode === "hang") return setTimeout(() => {}, 60_000);
  if (mode === "garbage") {
    process.stdout.write("not json");
    process.exit(3);
  }
  const resumeAt = argv.indexOf("--resume");
  const resumeId = resumeAt >= 0 ? argv[resumeAt + 1] : null;
  const forking = argv.includes("--fork-session");

  // Verified on 2.1.266: a running session refuses a plain --resume and says so,
  // but --fork-session branches a copy off it successfully.
  if (resumeId && mode === "busy" && !forking) {
    process.stderr.write(
      `Error: Session ${resumeId} is running as a background session (${resumeId.slice(0, 8)}). Run \`claude attach\` to open it, or \`claude stop\` first to resume it here. Add --fork-session to branch off a copy instead.\n`,
    );
    process.exit(1);
  }

  if (stateDir) {
    const file = (id) => join(stateDir, `${id}.json`);
    let sessionId;
    let turns;
    if (resumeId) {
      if (!existsSync(file(resumeId))) {
        process.stderr.write(`No conversation found with session ID: ${resumeId}\n`);
        process.exit(1);
      }
      turns = JSON.parse(readFileSync(file(resumeId), "utf8"));
      // A fork gets its own id and leaves the source transcript alone.
      sessionId = forking || mode === "fork" ? randomUUID() : resumeId;
    } else {
      turns = [];
      sessionId = randomUUID();
    }
    turns.push(input);
    writeFileSync(file(sessionId), JSON.stringify(turns));
    const remembered = /codeword ([A-Z0-9-]+)/.exec(turns.join("\n"))?.[1] ?? "none";
    process.stdout.write(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: sessionId,
        result: `turns=${turns.length} remembered=${remembered}`,
      }),
    );
    process.exit(0);
  }

  const isError = mode === "error";
  process.stdout.write(
    JSON.stringify({
      type: "result",
      subtype: isError ? "error_during_execution" : "success",
      is_error: isError,
      result: isError
        ? "tool failed"
        : `ok args=[${argv.join(" ")}] promptHasTask=${input.includes("<task>")}`,
      session_id: "11111111-2222-3333-4444-555555555555",
    }),
  );
  process.exit(isError ? 1 : 0);
});
