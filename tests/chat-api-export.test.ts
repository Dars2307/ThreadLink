import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const USER = { id: "tlusr_00112233445566778899aabbccddeeff" };
const CHAT = "tlcht_00112233445566778899aabbccddeeff";

const auth = vi.hoisted(() => ({ fail: false }));
const owner = vi.hoisted(() => ({ getMyChat: vi.fn(), listMyChatJobs: vi.fn() }));
const rows = vi.hoisted(() => ({ value: [] as Record<string, unknown>[] }));

vi.mock("@/lib/auth/threadlink-user", async () => {
  const { AuthenticationRequiredError } = await import("@/lib/auth/resolve-identity");
  return {
    requireThreadLinkUser: vi.fn(async () => {
      if (auth.fail) throw new AuthenticationRequiredError();
      return USER;
    }),
  };
});
vi.mock("@/lib/chat/owner", () => owner);
vi.mock("@/lib/supabase/server", () => {
  // A minimal PostgREST query builder over `rows` (newest first, as asked).
  const builder = () => {
    const q = {
      select: () => q,
      eq: () => q,
      order: () => q,
      range: async (from: number, to: number) => ({
        data: [...rows.value].reverse().slice(from, to + 1),
        error: null,
      }),
    };
    return q;
  };
  return { createUserSupabaseClient: () => ({ from: builder }) };
});

import { GET } from "@/app/api/dashboard/chats/[chatId]/export/route";
import {
  chatExportFileName,
  chatExportMarkdown,
  buildChatExport,
  escapeMarkdown,
  redactExportText,
} from "@/lib/export/chat-export";

const row = (seq: number, over: Record<string, unknown> = {}) => ({
  seq,
  owner_user_id: USER.id,
  chat_id: CHAT,
  created_at: `2026-09-26T00:00:0${seq}Z`,
  author_label: "You",
  author_role: null,
  event_type: "message",
  body: `message ${seq}`,
  ...over,
});
const ctx = (chatId = CHAT) => ({ params: Promise.resolve({ chatId }) });
const req = (q = "") => new Request(`http://localhost/api/dashboard/chats/${CHAT}/export${q}`);

beforeEach(() => {
  auth.fail = false;
  owner.getMyChat.mockReset().mockResolvedValue({
    name: "Prism auth",
    projectName: "Prism",
    mode: "pair",
  });
  owner.listMyChatJobs.mockReset().mockResolvedValue([
    {
      jobId: "tljob_00112233445566778899aabbccddeeff",
      goal: "Add rate limiting",
      mode: "pair",
      statusLabel: "Passed",
      verdict: "PASS",
      startedAt: "2026-09-26T00:00:00Z",
      finishedAt: "2026-09-26T01:00:00Z",
    },
  ]);
  rows.value = [
    row(1, { body: "Please fix login. My token: ghp_abcdefghijklmnopqrstuvwx" }),
    row(2, {
      author_label: "Codex",
      author_role: "reviewer",
      event_type: "agent_message",
      body: "Found an issue in C:\\Users\\nickron\\repo\\auth.ts <script>",
    }),
  ];
});

describe("chat export route", () => {
  it("signed out -> 401, nothing read", async () => {
    auth.fail = true;
    const res = await GET(req("?format=md"), ctx());
    expect(res.status).toBe(401);
    expect(owner.getMyChat).not.toHaveBeenCalled();
  });

  it("another account's (or a missing) chat -> 404", async () => {
    owner.getMyChat.mockResolvedValue(null);
    expect((await GET(req("?format=json"), ctx())).status).toBe(404);
    expect((await GET(req("?format=json"), ctx("tlcht_nope"))).status).toBe(404);
  });

  it("an unknown format -> 400", async () => {
    expect((await GET(req("?format=html"), ctx())).status).toBe(400);
  });

  it("JSON: names and text only, redacted, no ids or cursors", async () => {
    const res = await GET(req("?format=json"), ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="threadlink-prism-auth.json"',
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    const body = JSON.parse(text);
    expect(body.chat).toEqual({ name: "Prism auth", project: "Prism", mode: "pair" });
    expect(body.messages.map((m: { from: string }) => m.from)).toEqual(["You", "Codex"]);
    expect(body.messages[1].role).toBe("reviewer");
    expect(body.jobs[0]).toMatchObject({
      goal: "Add rate limiting",
      status: "Passed",
      verdict: "PASS",
    });
    expect(text).not.toMatch(/tl(cht|job|cev|ses|rom|usr)_|ghp_|nickron|"seq"/);
  });

  it("Markdown: escaped, quoted, redacted", async () => {
    const res = await GET(req(), ctx());
    expect(res.headers.get("content-type")).toContain("text/markdown");
    const md = await res.text();
    expect(md.startsWith("# Prism auth\n")).toBe(true);
    expect(md).toContain("**Codex \\(reviewer\\)**");
    expect(md).toContain("\\<script\\>");
    expect(md).not.toMatch(/ghp_|nickron|tljob_/);
  });

  it("a row of another owner is never exported (fail closed)", async () => {
    rows.value = [row(1, { owner_user_id: "tlusr_ffeeddccbbaa99887766554433221100" })];
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await GET(req("?format=json"), ctx())).status).toBe(503);
    spy.mockRestore();
  });
});

describe("chat export helpers", () => {
  it("redacts credential shapes and home directories", () => {
    const out = redactExportText(
      "key sk-abcdefghijklmnop1234 and Bearer abcdefghijkl and /home/alice/x and tlc_abcdefghijklmnopqrst",
    );
    expect(out).not.toMatch(/sk-abc|abcdefghijkl\b|alice|tlc_abc/);
  });
  it("escapes Markdown so text never becomes markup", () => {
    expect(escapeMarkdown("[x](javascript:alert(1)) <b>")).toBe(
      "\\[x\\]\\(javascript:alert\\(1\\)\\) \\<b\\>",
    );
  });
  it("file names are ascii slugs", () => {
    expect(chatExportFileName('Ünïcode "chat"/../x', "md")).toBe("threadlink-unicode-chat-x.md");
    expect(chatExportFileName("!!!", "json")).toBe("threadlink-chat.json");
  });
  it("says when it was cut", () => {
    const e = buildChatExport({
      exportedAt: "2026-09-26T00:00:00Z",
      chat: { name: "x", projectName: null, mode: "team" },
      messages: [],
      jobs: [],
      truncated: true,
    });
    expect(chatExportMarkdown(e)).toContain("Only the newest 10,000 messages are included.");
    expect(chatExportMarkdown(e)).toContain("- Project: none");
  });
});
