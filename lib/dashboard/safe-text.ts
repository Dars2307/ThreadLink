/**
 * The safe message renderer's pure half (brief §86–§88): turns an untrusted
 * body into a small token tree that React renders as TEXT NODES only. There is
 * no HTML path anywhere: no dangerouslySetInnerHTML, no markdown-to-HTML.
 *
 * - ANSI escape sequences and C0/C1 control characters (except \n and \t) are
 *   stripped; bidi overrides are removed so text cannot reorder itself.
 * - Fenced code blocks (``` … ```) become code blocks (copyable, monospace).
 * - Inline `code` becomes inline code.
 * - Only http(s) URLs become links; the component adds rel="noopener
 *   noreferrer nofollow" and target=_blank. javascript:, data:, file: … stay text.
 * - Huge bodies are cut at DISPLAY_MAX characters with a note; the full text is
 *   still available through the artifact/export paths, never rendered here.
 */

export const DISPLAY_MAX = 64 * 1024;
export const CODE_BLOCK_MAX_LINES = 400;

/** CSI / OSC / other ESC sequences, then any stray control char except \n and \t. */
const ANSI =
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]|\u009b[0-?]*[ -/]*[@-~]/g;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
/** Bidi embedding/override/isolate controls (Trojan Source). */
const BIDI = /[‪-‮⁦-⁩‎‏؜]/g;

/** Plain, printable text: no ANSI, no control characters, normalised newlines. */
export function cleanText(input: unknown): string {
  if (typeof input !== "string") return "";
  return input.replace(/\r\n?/g, "\n").replace(ANSI, "").replace(CONTROL, "").replace(BIDI, "");
}

export type InlineToken =
  { t: "text"; v: string } | { t: "code"; v: string } | { t: "link"; v: string; href: string };

export type BlockToken =
  | { t: "para"; parts: InlineToken[] }
  | { t: "code"; lang: string | null; v: string; truncatedLines: number };

export type SafeDoc = { blocks: BlockToken[]; truncated: boolean; chars: number };

/** Only absolute http(s) URLs; anything else is not a link. */
export function safeHref(raw: string): string | null {
  const trimmed = raw.replace(/[),.;:!?'"\]]+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const u = new URL(trimmed);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password) return null;
    return u.toString();
  } catch {
    return null;
  }
}

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;

function linkify(text: string): InlineToken[] {
  const out: InlineToken[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const raw = m[0];
    const href = safeHref(raw);
    if (!href) continue;
    // Trailing punctuation stays text.
    const visible = raw.replace(/[),.;:!?'"\]]+$/, "");
    const start = m.index ?? 0;
    if (start > last) out.push({ t: "text", v: text.slice(last, start) });
    out.push({ t: "link", v: visible, href });
    last = start + visible.length;
  }
  if (last < text.length) out.push({ t: "text", v: text.slice(last) });
  return out;
}

function inline(text: string): InlineToken[] {
  const out: InlineToken[] = [];
  const parts = text.split(/(`[^`\n]{1,400}`)/g);
  for (const p of parts) {
    if (!p) continue;
    if (p.length >= 2 && p.startsWith("`") && p.endsWith("`"))
      out.push({ t: "code", v: p.slice(1, -1) });
    else out.push(...linkify(p));
  }
  return out;
}

/** Tokenises an untrusted body. Pure and bounded: O(n) in the (capped) body length. */
export function tokenize(input: unknown, max = DISPLAY_MAX): SafeDoc {
  const clean = cleanText(input);
  const truncated = clean.length > max;
  const body = truncated ? clean.slice(0, max) : clean;
  const blocks: BlockToken[] = [];
  const lines = body.split("\n");
  let para: string[] = [];
  const flush = () => {
    if (para.length) {
      const text = para.join("\n");
      if (text.trim()) blocks.push({ t: "para", parts: inline(text) });
      para = [];
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^\s*```([A-Za-z0-9_+.-]{0,20})\s*$/.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      let j = i + 1;
      while (j < lines.length && !/^\s*```\s*$/.test(lines[j]!)) code.push(lines[j++]!);
      const kept = code.slice(0, CODE_BLOCK_MAX_LINES);
      blocks.push({
        t: "code",
        lang: fence[1] || null,
        v: kept.join("\n"),
        truncatedLines: code.length - kept.length,
      });
      i = j; // skip the closing fence (or run to the end when unclosed)
      continue;
    }
    if (line.trim() === "" && para.length) {
      flush();
      continue;
    }
    para.push(line);
  }
  flush();
  return { blocks, truncated, chars: clean.length };
}

/** One line of plain text for previews and quote chips. */
export function oneLine(input: unknown, max = 140): string {
  const s = cleanText(input)
    .replace(/```[\s\S]*?(```|$)/g, " [code] ")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}
