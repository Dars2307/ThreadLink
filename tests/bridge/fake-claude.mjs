// Test double for `claude -p --output-format json`: reads the prompt on stdin
// and prints a Claude-Code-shaped JSON result. Behaviour is chosen by env var.
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const mode = process.env.FAKE_CLAUDE_MODE ?? "ok";
  if (mode === "hang") return setTimeout(() => {}, 60_000);
  if (mode === "garbage") {
    process.stdout.write("not json");
    process.exit(3);
  }
  const argv = process.argv.slice(2).join(" ");
  const isError = mode === "error";
  process.stdout.write(
    JSON.stringify({
      type: "result",
      subtype: isError ? "error_during_execution" : "success",
      is_error: isError,
      result: isError
        ? "tool failed"
        : `ok args=[${argv}] promptHasTask=${input.includes("<task>")}`,
      session_id: "11111111-2222-3333-4444-555555555555",
    }),
  );
  process.exit(isError ? 1 : 0);
});
