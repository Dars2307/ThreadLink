/**
 * Chat export (brief §79): the owner downloads one chat as Markdown or JSON.
 *
 * Pure. What goes in: the chat's name, project and mode, its VISIBLE
 * messages (who, when, what) and its jobs' outcomes. What never goes in: any
 * id (chat, job, task, session, event), the global seq, native provider
 * session ids, idempotency keys, model internals, technical rows. Bodies are
 * redacted when stored; they are redacted AGAIN here (defence in depth) with
 * the same credential shapes as the database's redact_text.
 */

export const CHAT_EXPORT_FORMATS = ["md", "json"] as const;
export type ChatExportFormat = (typeof CHAT_EXPORT_FORMATS)[number];

/** At most this many messages are exported (newest kept); the export says when it was cut. */
export const CHAT_EXPORT_MAX_MESSAGES = 10_000;

export type ChatExportMessage = {
  at: string;
  from: string;
  role: string | null;
  kind: string;
  text: string;
};

export type ChatExportJob = {
  goal: string;
  mode: string | null;
  status: string;
  verdict: string | null;
  startedAt: string;
  finishedAt: string | null;
};

export type ChatExport = {
  format: "threadlink.chat-export";
  version: 1;
  exportedAt: string;
  chat: { name: string; project: string | null; mode: string };
  messages: ChatExportMessage[];
  jobs: ChatExportJob[];
  /** True when older messages were left out (more than CHAT_EXPORT_MAX_MESSAGES). */
  truncated: boolean;
};

const R = "[redacted]";

/** Credential-shaped content, matched on shape (mirrors threadlink_private.redact_text). */
export function redactExportText(input: string): string {
  let t = input;
  t = t.replace(/-----BEGIN[A-Z ]*PRIVATE KEY-----[^-]*(-----END[A-Z ]*PRIVATE KEY-----)?/g, R);
  t = t.replace(/https?:\/\/hooks\.slack\.com\/(services|workflows)\/[A-Za-z0-9/_-]+/gi, R);
  t = t.replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/:@]*:[^\s/@]+@/g, `$1${R}@`);
  t = t.replace(/\b(bearer|basic)(\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1$2${R}`);
  t = t.replace(/((set-)?cookie\s*:)[^\n]*/gi, `$1 ${R}`);
  t = t.replace(
    /((aws_secret_access_key|aws_session_token|aws_access_key_id)\s+)[^\s=:]+/gi,
    `$1${R}`,
  );
  // 0.11: only a value that looks like a secret (a digit, or 16+ characters).
  t = t.replace(
    /((password|passphrase|passwd|secret|token|api[ _-]?key)\s+(is|was)\s+)(["'`]?\S*\d\S*|\S{16,})/gi,
    `$1${R}`,
  );
  t = t.replace(
    /([A-Za-z0-9_-]*(password|passwd|pwd|secret|token|api[-_]?key|access[-_]?key|private[-_]?key)[A-Za-z0-9_-]*["']?\s*[:=]\s*)[^\n]+/gi,
    `$1${R}`,
  );
  // 0.10: env / shell / YAML / JSON names ending in KEY, PASS, CREDS, CREDENTIALS.
  t = t.replace(
    /(\b[A-Za-z0-9_]*(KEY|PASS|CREDS?|CREDENTIALS?|Key|Pass|Creds?|Credentials?|_key|_pass|_creds?|_credentials?)["']?\s*[:=]\s*)[^\n]+/g,
    `$1${R}`,
  );
  t = t.replace(/(\b([A-Za-z0-9_-]*(credentials?|creds)|pass)["']?\s*[:=]\s*)[^\n]+/gi, `$1${R}`);
  t = t.replace(/\b(sk|pk|rk)[-_][A-Za-z0-9_-]{12,}/gi, R);
  t = t.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, R);
  t = t.replace(/\bgh[pousr]_[A-Za-z0-9]{16,}/g, R);
  t = t.replace(/\bxox[abprse]-[A-Za-z0-9-]{10,}/gi, R);
  t = t.replace(/\b(AKIA|ASIA)[0-9A-Z]{12,}/g, R);
  t = t.replace(/\bAIza[0-9A-Za-z_-]{30,}/g, R);
  t = t.replace(/\bglpat-[A-Za-z0-9_-]{20,}/g, R);
  t = t.replace(/\bnpm_[A-Za-z0-9]{30,}/g, R);
  t = t.replace(/\btlc_[A-Za-z0-9_-]{16,}/g, R);
  t = t.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, R);
  // A home directory names a person.
  t = t.replace(/([A-Za-z]:[\\/](Users|Documents and Settings)[\\/])[^\\/\s"'<>|]+/gi, "$1…");
  t = t.replace(/(\/(home|Users)\/)[^/\s"'<>|]+/g, "$1…");
  // Control characters other than newline and tab; bidi / zero-width tricks.
  t = t.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
  t = t.replace(/[​-‏‪-‮⁦-⁩﻿]/g, "");
  return t;
}

/** A label or name: one line, no control characters, redacted. */
const oneLine = (v: string, max = 200) =>
  redactExportText(v).replace(/\s+/g, " ").trim().slice(0, max);

export function buildChatExport(input: {
  exportedAt: string;
  chat: { name: string; projectName: string | null; mode: string };
  messages: { at: string; from: string; role: string | null; kind: string; text: string }[];
  jobs: ChatExportJob[];
  truncated: boolean;
}): ChatExport {
  return {
    format: "threadlink.chat-export",
    version: 1,
    exportedAt: input.exportedAt,
    chat: {
      name: oneLine(input.chat.name, 100),
      project: input.chat.projectName === null ? null : oneLine(input.chat.projectName, 100),
      mode: input.chat.mode,
    },
    messages: input.messages.map((m) => ({
      at: m.at,
      from: oneLine(m.from, 60),
      role: m.role,
      kind: m.kind,
      text: redactExportText(m.text),
    })),
    jobs: input.jobs.map((j) => ({
      goal: redactExportText(j.goal),
      mode: j.mode,
      status: j.status,
      verdict: j.verdict,
      startedAt: j.startedAt,
      finishedAt: j.finishedAt,
    })),
    truncated: input.truncated,
  };
}

const MODE_LABEL: Record<string, string> = {
  team: "Team",
  pair: "Builder + Reviewer",
  solo: "Solo",
};

/** Markdown text never becomes markup: every character with meaning is escaped. */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, (c) => `\\${c}`);
}

export function chatExportMarkdown(e: ChatExport): string {
  const lines: string[] = [];
  lines.push(`# ${escapeMarkdown(e.chat.name)}`, "");
  lines.push(`- Project: ${e.chat.project === null ? "none" : escapeMarkdown(e.chat.project)}`);
  lines.push(`- Mode: ${MODE_LABEL[e.chat.mode] ?? escapeMarkdown(e.chat.mode)}`);
  lines.push(`- Exported: ${e.exportedAt}`);
  if (e.truncated) {
    lines.push(
      `- Only the newest ${CHAT_EXPORT_MAX_MESSAGES.toLocaleString("en-US")} messages are included.`,
    );
  }
  lines.push("");
  if (e.jobs.length > 0) {
    lines.push("## Work", "");
    for (const j of e.jobs) {
      const outcome = j.verdict ? `${j.status}, ${j.verdict}` : j.status;
      lines.push(
        `- ${escapeMarkdown(j.goal.replace(/\s+/g, " ").slice(0, 200))} (${escapeMarkdown(outcome)})`,
      );
    }
    lines.push("");
  }
  lines.push("## Messages", "");
  for (const m of e.messages) {
    const who = m.role ? `${m.from} (${m.role.replace(/_/g, " ")})` : m.from;
    lines.push(`**${escapeMarkdown(who)}** · ${m.at}`, "");
    for (const line of m.text.split("\n")) lines.push(`> ${escapeMarkdown(line)}`);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** A safe download file name: ascii letters, digits and dashes only. */
export function chatExportFileName(name: string, format: ChatExportFormat): string {
  const slug =
    name
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^A-Za-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase()
      .slice(0, 60) || "chat";
  return `threadlink-${slug}.${format}`;
}
