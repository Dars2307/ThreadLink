/**
 * The final report artifact (docs/design/threadlink-0.10.md §4): markdown the
 * Runtime builds from job data only -- the verdict and its fixed reason, units
 * and who built and reviewed them, findings by severity and state, the tests
 * ThreadLink itself ran, the agents that took part, the final verifier, and
 * what remains open. Agent prose is not copied in: unit titles and finding
 * titles are the only agent-written strings, and they are redacted.
 */

import { redactText } from "../summary.ts";

export type ReportFinding = {
  severity: "blocking" | "important" | "non_blocking";
  status: string;
  title: string;
  unit: string | null;
  raisedBy: string;
};

export type ReportInput = {
  room: string;
  verdict: string;
  /** ThreadLink's own verdict summary (fixed text + trusted names), redacted. */
  summary: string;
  reason: string | null;
  mode: string;
  units: { key: string; title: string; owner: string; reviewer: string | null; status: string }[];
  findings: ReportFinding[];
  tests: { command: string; ok: boolean; exitCode: number | null }[];
  agents: { name: string; roles: string[] }[];
  finalVerifier: string | null;
  integrationBranch: string | null;
  uncertainty: string[];
};

const OPEN_STATES = new Set(["open", "accepted", "disputed", "fixed"]);

function cell(text: string): string {
  return redactText(text, 200).replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

export function finalReportMarkdown(input: ReportInput): string {
  const lines: string[] = [];
  lines.push(`# ThreadLink report — ${cell(input.room)}`, "");
  lines.push(`**Verdict:** ${input.verdict}${input.reason ? ` (${input.reason})` : ""}`);
  lines.push(`**Mode:** ${input.mode}`, "");
  lines.push(redactText(input.summary, 2_000), "");

  lines.push("## Units of work", "");
  if (!input.units.length) lines.push("No units of work were started.", "");
  else {
    lines.push("| Unit | Built by | Reviewed by | Status |", "| --- | --- | --- | --- |");
    for (const u of input.units) {
      lines.push(`| ${cell(u.title)} | ${u.owner} | ${u.reviewer ?? "—"} | ${u.status} |`);
    }
    lines.push("");
  }

  lines.push("## Findings", "");
  const severities = ["blocking", "important", "non_blocking"] as const;
  const states = [...new Set(input.findings.map((f) => f.status))].sort();
  if (!input.findings.length) lines.push("No findings were raised.", "");
  else {
    lines.push(
      `| Severity | ${states.join(" | ")} |`,
      `| --- |${states.map(() => " --- |").join("")}`,
    );
    for (const sev of severities) {
      const counts = states.map(
        (st) => input.findings.filter((f) => f.severity === sev && f.status === st).length,
      );
      lines.push(`| ${sev.replace("_", "-")} | ${counts.join(" | ")} |`);
    }
    lines.push("");
    const open = input.findings.filter(
      (f) => OPEN_STATES.has(f.status) && f.severity !== "non_blocking",
    );
    if (open.length) {
      lines.push("Still open:", "");
      for (const f of open) {
        lines.push(`- [${f.severity}] ${cell(f.title)} — raised by ${f.raisedBy}, ${f.status}`);
      }
      lines.push("");
    }
  }

  lines.push("## Tests (run by ThreadLink)", "");
  if (!input.tests.length) lines.push("No test commands were run.", "");
  else {
    for (const t of input.tests) {
      lines.push(
        `- ${t.ok ? "passed" : "FAILED"} (exit ${t.exitCode ?? "?"}): \`${cell(t.command)}\``,
      );
    }
    lines.push("");
  }

  lines.push("## Team", "");
  for (const a of input.agents) lines.push(`- ${a.name}: ${a.roles.join(", ") || "—"}`);
  lines.push(`- Final verifier: ${input.finalVerifier ?? "none (no final inspection)"}`, "");

  if (input.integrationBranch)
    lines.push(`Result branch: \`${cell(input.integrationBranch)}\``, "");

  const openCount = input.findings.filter(
    (f) => OPEN_STATES.has(f.status) && f.severity !== "non_blocking",
  ).length;
  lines.push(`Remaining open items: ${openCount}`, "");

  if (input.uncertainty.length) {
    lines.push("## Worth knowing", "");
    for (const u of input.uncertainty) lines.push(`- ${redactText(u, 500)}`);
    lines.push("");
  }
  return lines.join("\n");
}
