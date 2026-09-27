/**
 * Text attachments (docs/design/threadlink-0.10.md §4): at most 64 KiB, text
 * only, stored as a `user_attachment` artifact. They are never sent to an
 * agent unless the owner mentions them in a message. Pure; used by the
 * composer (early feedback) and the server action (the real check).
 */

export const ATTACHMENT_MAX_BYTES = 64 * 1024;

const TEXT_EXT =
  /\.(txt|md|markdown|log|json|ya?ml|toml|ini|cfg|conf|csv|tsv|xml|html?|css|scss|js|jsx|mjs|cjs|ts|tsx|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|ps1|sql|diff|patch|env\.example|gitignore|dockerfile)$/i;
const TEXT_MIME =
  /^(text\/[a-z0-9.+-]+|application\/(json|xml|x-yaml|yaml|toml|x-sh|javascript|typescript|sql))$/i;

export type AttachmentCheck =
  | { ok: true; title: string; mime: "text/plain" | "text/markdown" }
  | { ok: false; message: string };

/** A safe display title: basename only, printable, ≤ 120 chars. */
export function attachmentTitle(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, "").trim();
  return (clean || "attachment.txt").slice(0, 120);
}

export function checkAttachment(file: {
  name: string;
  size: number;
  type: string;
}): AttachmentCheck {
  if (!Number.isFinite(file.size) || file.size <= 0)
    return { ok: false, message: "That file is empty." };
  if (file.size > ATTACHMENT_MAX_BYTES) {
    return { ok: false, message: "Attachments can be up to 64 KB of text." };
  }
  const title = attachmentTitle(file.name);
  const mime = (file.type || "").toLowerCase();
  if (!(
    TEXT_MIME.test(mime) ||
    ((!mime || mime === "application/octet-stream") && TEXT_EXT.test(title))
  )) {
    return { ok: false, message: "Only text files can be attached." };
  }
  // The server stores text/plain or text/markdown only.
  return {
    ok: true,
    title,
    mime:
      /\.(md|markdown)$/i.test(title) || mime === "text/markdown" ? "text/markdown" : "text/plain",
  };
}

/** Decodes as strict UTF-8 and refuses binary (NUL bytes). */
export function decodeText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function formatBytes(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
