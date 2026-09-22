import { z } from "zod";

import {
  linkActionInputSchema,
  linkRowSchema,
  requestPairingInputSchema,
  toThreadLinkView,
  type ThreadLinkView,
} from "@/lib/pairing/model";
import {
  registerSessionInputSchema,
  sessionIdSchema,
  sessionReferenceInputSchema,
  sessionRowSchema,
  toClientSession,
  type ClientSession,
} from "@/lib/sessions/model";

/**
 * Connection-authenticated session and pairing operations.
 *
 * Every call passes the credential HMAC so the database re-verifies the
 * connection inside the operation; owner, connection, role and platform are
 * derived there, never taken from the client.
 */

type RpcError = { message: string; code?: string } | null;
export type ClientDatabase = {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: RpcError }>;
};

export type ClientErrorKind =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "invalid"
  | "too_large"
  | "limit"
  | "unavailable";

export class ClientOperationError extends Error {
  constructor(readonly kind: ClientErrorKind) {
    super(kind);
    this.name = "ClientOperationError";
  }
}

const ERROR_KINDS: Record<string, ClientErrorKind> = {
  "28000": "unauthorized",
  "42501": "forbidden",
  P0002: "not_found",
  "55000": "conflict",
  "54000": "limit",
  "23514": "invalid",
  "23502": "invalid",
  "22023": "invalid",
};

export async function call<T>(
  db: ClientDatabase,
  fn: string,
  args: Record<string, unknown>,
  parse: (data: unknown) => T,
): Promise<T> {
  let result: { data: unknown; error: RpcError };
  try {
    result = await db.rpc(fn, args);
  } catch {
    throw new ClientOperationError("unavailable");
  }
  if (result.error) {
    throw new ClientOperationError(ERROR_KINDS[result.error.code ?? ""] ?? "unavailable");
  }
  try {
    return parse(result.data);
  } catch {
    throw new ClientOperationError("unavailable");
  }
}

export function validate<S extends z.ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    // Payload size (bytes, long strings, long arrays) -> 413; numeric range -> 400.
    const oversized = parsed.error.issues.some(
      (issue) =>
        /bytes$/.test(issue.message) ||
        (issue.code === "too_big" && "origin" in issue && issue.origin !== "number"),
    );
    throw new ClientOperationError(oversized ? "too_large" : "invalid");
  }
  return parsed.data;
}

const parseSession = (data: unknown) => sessionRowSchema.parse(data);
const parseLink = (data: unknown): ThreadLinkView => toThreadLinkView(linkRowSchema.parse(data));

export async function registerSession(
  db: ClientDatabase,
  credentialHash: string,
  rawInput: unknown,
): Promise<{ session: ClientSession; created: boolean }> {
  const input = validate(registerSessionInputSchema, rawInput ?? {});
  const row = await call(
    db,
    "register_session",
    {
      p_token_hash: credentialHash,
      p_display_name: input.displayName ?? null,
      p_provider_session_ref: input.providerSessionRef ?? null,
      p_local_binding_ref: input.localBindingRef ?? null,
    },
    parseSession,
  );
  return { session: toClientSession(row), created: row.created === true };
}

export async function getSession(
  db: ClientDatabase,
  credentialHash: string,
  sessionId: unknown,
): Promise<ClientSession> {
  const id = validate(sessionIdSchema, sessionId);
  const row = await call(
    db,
    "get_session",
    { p_token_hash: credentialHash, p_session_id: id },
    parseSession,
  );
  return toClientSession(row);
}

export async function retireSession(
  db: ClientDatabase,
  credentialHash: string,
  rawInput: unknown,
): Promise<ClientSession> {
  const { sessionId } = validate(sessionReferenceInputSchema, rawInput);
  const row = await call(
    db,
    "retire_session",
    { p_token_hash: credentialHash, p_session_id: sessionId },
    parseSession,
  );
  return toClientSession(row);
}

export async function requestPairing(
  db: ClientDatabase,
  credentialHash: string,
  rawInput: unknown,
): Promise<ThreadLinkView> {
  const input = validate(requestPairingInputSchema, rawInput);
  return call(
    db,
    "request_pairing",
    {
      p_token_hash: credentialHash,
      p_controller_session_id: input.controllerSessionId,
      p_agent_session_id: input.agentSessionId,
    },
    parseLink,
  );
}

export async function approvePairing(
  db: ClientDatabase,
  credentialHash: string,
  rawInput: unknown,
): Promise<ThreadLinkView> {
  const { sessionId, linkId } = validate(linkActionInputSchema, rawInput);
  return call(
    db,
    "approve_pairing",
    { p_token_hash: credentialHash, p_agent_session_id: sessionId, p_link_id: linkId },
    parseLink,
  );
}

export async function revokePairing(
  db: ClientDatabase,
  credentialHash: string,
  rawInput: unknown,
): Promise<ThreadLinkView> {
  const { sessionId, linkId } = validate(linkActionInputSchema, rawInput);
  return call(
    db,
    "revoke_pairing",
    { p_token_hash: credentialHash, p_session_id: sessionId, p_link_id: linkId },
    parseLink,
  );
}

export async function listSessionLinks(
  db: ClientDatabase,
  credentialHash: string,
  sessionId: unknown,
): Promise<ThreadLinkView[]> {
  const id = validate(sessionIdSchema, sessionId);
  return call(
    db,
    "list_session_links",
    { p_token_hash: credentialHash, p_session_id: id },
    (data) => z.array(linkRowSchema).parse(data).map(toThreadLinkView),
  );
}
