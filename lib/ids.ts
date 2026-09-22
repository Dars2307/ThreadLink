/**
 * ThreadLink-owned identifiers: `<prefix>_<32 lowercase hex>`.
 *
 * IDs are generated only by the database (`threadlink_private.generate_id`,
 * backed by gen_random_uuid()). Application code validates them but never
 * mints them, and never derives them from names, emails or Clerk IDs.
 */
export const ID_PREFIXES = {
  user: "tlusr",
  connection: "tlcon",
  credential: "tlcrd",
  auditEvent: "tlevt",
  sessionBinding: "tlses",
  threadLink: "tllnk",
  task: "tltask",
  message: "tlmsg",
  artifact: "tlart",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

const ID_BODY = "[0-9a-f]{32}";

export function idPattern(kind: IdKind): RegExp {
  return new RegExp(`^${ID_PREFIXES[kind]}_${ID_BODY}$`);
}

export function isThreadLinkId(kind: IdKind, value: unknown): value is string {
  return typeof value === "string" && idPattern(kind).test(value);
}
