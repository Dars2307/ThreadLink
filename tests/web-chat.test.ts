import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { ActionStatus } from "@/components/dashboard/action-form";
import { ProjectChat } from "@/components/dashboard/project-chat";
import type { ChatEvent, ChatPage } from "@/lib/chat/types";
import { failed, runAction, saved } from "@/lib/dashboard/action-result";
import {
  announcement,
  chatItemView,
  checkDraft,
  COMPOSER_MAX,
  groupChat,
  IDLE_AFTER_MS,
  isChatPage,
  isPostResult,
  jobRequest,
  mentionOf,
  mergeEvents,
  modelLine,
  nextCursor,
  pollDelay,
  previewOf,
  routeBanner,
  safeServerMessage,
  SEND_FAILED,
  sendOutcome,
  shouldCollapse,
} from "@/lib/dashboard/chat";
import { deriveProject, parseJobParam, parseTab, projectHref } from "@/lib/dashboard/project";
import type { OwnerRoom } from "@/lib/rooms/queries";
import type { OwnerJobSummary } from "@/lib/team/queries";

const hex = (n: number) => n.toString(16).padStart(32, "0");
const ROOM = `tlrom_${hex(1)}`;
const JOB = `tljob_${hex(1)}`;
const JOB_OLD = `tljob_${hex(2)}`;
const AGENT = `tlses_${hex(9)}`;
const ID = /\btl[a-z]{2,5}_[0-9a-f]/;

let n = 0;
const event = (over: Partial<ChatEvent>): ChatEvent => {
  n += 1;
  return {
    seq: n,
    id: `tlcev_${hex(n)}`,
    createdAt: new Date(Date.parse("2026-09-25T12:00:00Z") + n * 1000).toISOString(),
    roomId: ROOM,
    agentSessionId: AGENT,
    jobId: JOB,
    taskId: null,
    nodeId: null,
    authorKind: "agent",
    authorProvider: "claude-code",
    authorLabel: "Claude Code",
    authorRole: "builder",
    audience: null,
    eventType: "agent_message",
    messageType: "proposal",
    round: 1,
    modelRequested: "claude-sonnet-5",
    modelObserved: "claude-sonnet-5",
    body: "Plan: add a health check.",
    visibility: "visible",
    ...over,
  };
};

describe("chat: one event → what the timeline shows", () => {
  it("labels an agent bubble with provider, role, round and the model it used", () => {
    const v = chatItemView(event({}));
    expect(v).toMatchObject({
      kind: "bubble",
      author: "agent",
      side: "left",
      label: "Claude Code",
      badge: "Claude Code",
      role: "Builder",
      round: "Round 1",
      model: "Claude Sonnet 5",
      modelMismatch: false,
      kindLabel: "Proposal",
    });
  });

  it("flags a model mismatch: requested X, used Y", () => {
    const v = chatItemView(
      event({
        authorProvider: "codex",
        authorLabel: "Codex",
        modelRequested: "gpt-5.5-codex",
        modelObserved: "gpt-5.4",
      }),
    );
    expect(v).toMatchObject({
      badge: "Codex",
      model: "Requested GPT-5.5 Codex, used GPT-5.4",
      modelMismatch: true,
    });
    expect(modelLine(null, null)).toEqual({ text: null, mismatch: false });
    expect(modelLine("claude-opus-5-5", null)).toEqual({
      text: "Claude Opus 5.5 (requested)",
      mismatch: false,
    });
  });

  it("puts the owner on the right and the controller on the left with its real client name", () => {
    const owner = chatItemView(
      event({
        authorKind: "owner",
        authorProvider: null,
        authorLabel: "You",
        authorRole: null,
        eventType: "message",
        messageType: null,
        audience: "codex",
        round: null,
      }),
    );
    expect(owner).toMatchObject({ side: "right", label: "You", badge: null, audience: "To Codex" });
    const controller = chatItemView(
      event({
        authorKind: "controller",
        authorProvider: null,
        authorLabel: "ChatGPT",
        authorRole: null,
        eventType: "request",
        messageType: null,
        modelObserved: "claude-sonnet-5",
      }),
    );
    expect(controller).toMatchObject({ side: "left", label: "ChatGPT", badge: "Controller" });
    // Only agents carry a model line: a controller cannot claim one.
    expect(controller.kind === "bubble" && controller.model).toBeNull();
  });

  it("renders ThreadLink events as milestones, never as bubbles", () => {
    const v = chatItemView(
      event({
        authorKind: "threadlink",
        authorProvider: null,
        authorLabel: "ThreadLink",
        eventType: "job_verdict",
        body: "Result: PASS\n  all checks green",
      }),
    );
    expect(v).toMatchObject({
      kind: "milestone",
      text: "Result: PASS all checks green",
      tone: "success",
    });
  });

  it("keeps an agent that writes 'ThreadLink: PASS' in an agent bubble", () => {
    const v = chatItemView(event({ body: "ThreadLink: PASS", authorLabel: "Claude Code" }));
    expect(v.kind).toBe("bubble");
  });

  it("collapses long bodies behind Show more", () => {
    const long = "word ".repeat(400);
    expect(shouldCollapse(long)).toBe(true);
    expect(shouldCollapse("short")).toBe(false);
    expect(shouldCollapse(Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n"))).toBe(true);
    const preview = previewOf(long);
    expect(preview.length).toBeLessThan(long.length);
    expect(preview.endsWith("…")).toBe(true);
    const v = chatItemView(event({ body: long }));
    expect(v.kind === "bubble" && v.collapsible).toBe(true);
  });
});

describe("chat: grouping", () => {
  it("groups consecutive messages by the same speaker; milestones stand alone", () => {
    const a1 = event({});
    const a2 = event({ body: "Second message" });
    const m = event({
      authorKind: "threadlink",
      authorProvider: null,
      authorLabel: "ThreadLink",
      eventType: "plan_agreed",
      body: "Plan agreed",
    });
    const a3 = event({});
    const r = event({ authorProvider: "codex", authorLabel: "Codex", authorRole: "reviewer" });
    const groups = groupChat([a1, a2, m, a3, r]);
    expect(groups.map((g) => (g.kind === "milestone" ? "M" : g.items.length))).toEqual([
      2,
      "M",
      1,
      1,
    ]);
  });

  it("starts a new group after a long pause", () => {
    const a1 = event({});
    const a2 = event({ createdAt: new Date(Date.parse(a1.createdAt) + 10 * 60_000).toISOString() });
    expect(groupChat([a1, a2])).toHaveLength(2);
  });

  it("hides technical events unless asked", () => {
    const t = event({
      authorKind: "threadlink",
      authorProvider: null,
      authorLabel: "ThreadLink",
      eventType: "model_used",
      visibility: "technical",
      body: "Model used",
    });
    expect(groupChat([t])).toHaveLength(0);
    expect(groupChat([t], { technical: true })).toHaveLength(1);
  });
});

describe("chat: merging polled pages", () => {
  it("appends by seq and never shows an id twice", () => {
    const a = event({});
    const b = event({});
    const c = event({});
    const merged = mergeEvents([a, b], [b, c, a]);
    expect(merged.map((e) => e.id)).toEqual([a.id, b.id, c.id]);
    expect(mergeEvents([c], [a]).map((e) => e.seq)).toEqual([a.seq, c.seq]);
  });

  it("never moves the cursor backwards", () => {
    expect(nextCursor(10, { cursor: 4, events: [] })).toBe(10);
    expect(nextCursor(10, { cursor: 12, events: [event({ seq: 15 })] })).toBe(15);
  });

  it("checks the page shape before trusting it", () => {
    const page: ChatPage = { events: [event({})], cursor: 1, activeJob: null };
    expect(isChatPage(page)).toBe(true);
    expect(isChatPage({ events: "x", cursor: 1, activeJob: null })).toBe(false);
    expect(isChatPage({ events: [{ id: 1 }], cursor: 1, activeJob: null })).toBe(false);
    expect(isChatPage(null)).toBe(false);
  });
});

describe("chat: composer", () => {
  it("reads a leading @mention only as a hint", () => {
    expect(mentionOf("@Claude fix it")).toBe("claude-code");
    expect(mentionOf("  @codex review")).toBe("codex");
    expect(mentionOf("@team build it")).toBe("team");
    expect(mentionOf("@team stop after this review round")).toBe("stop");
    expect(mentionOf("hello @claude")).toBeNull();
    expect(mentionOf("@claudette")).toBeNull();
  });

  it("bounds the draft", () => {
    expect(checkDraft("   ")).toEqual({ ok: false, message: "Write a message first." });
    expect(checkDraft("x".repeat(COMPOSER_MAX + 1)).ok).toBe(false);
    expect(checkDraft("  hi  ")).toEqual({ ok: true, body: "hi" });
  });

  it("says whether a message goes to the running job or starts a new one", () => {
    const job = { jobId: JOB, mode: "team" as const, status: "building" };
    expect(routeBanner(job, "hello").text).toMatch(/goes to the running job/);
    expect(routeBanner(job, "@team stop after this review round").text).toMatch(/then stops/);
    expect(routeBanner(null, "hello").text).toBe("Starts a new job in this project.");
  });

  it("derives mode and builder from the picker and a mention", () => {
    expect(jobRequest("@codex fix", { mode: "team", builder: "claude-code" })).toEqual({
      mode: "solo",
      builder: "codex",
    });
    expect(jobRequest("@codex fix", { mode: "pair", builder: "claude-code" })).toEqual({
      mode: "pair",
      builder: "codex",
    });
    expect(jobRequest("@team go", { mode: "solo", builder: "codex" })).toEqual({ mode: "team" });
    expect(jobRequest("go", { mode: "pair", builder: "codex" })).toEqual({
      mode: "pair",
      builder: "codex",
    });
  });

  it("explains the routed result and keeps server errors human-safe", () => {
    expect(sendOutcome({ ok: true, routed: "new_job", jobId: JOB }).message).toBe(
      "Started a new job.",
    );
    expect(sendOutcome({ ok: true, routed: "note_to_active_job", jobId: JOB }).message).toMatch(
      /running job/,
    );
    expect(sendOutcome({ ok: true, routed: "stop_requested", jobId: JOB }).message).toMatch(/Stop/);
    expect(
      sendOutcome({ ok: false, message: "This project's conversation isn't linked any more." }),
    ).toEqual({ ok: false, message: "This project's conversation isn't linked any more." });
    expect(safeServerMessage("ERROR: duplicate key (SQLSTATE 23505) in postgres")).toBe(
      SEND_FAILED,
    );
    expect(safeServerMessage("<b>x</b>")).toBe(SEND_FAILED);
    expect(safeServerMessage(undefined)).toBe(SEND_FAILED);
    expect(isPostResult({ ok: true, routed: "new_job", jobId: null })).toBe(true);
    expect(isPostResult({ ok: true, routed: "whatever" })).toBe(false);
    expect(isPostResult({ ok: false })).toBe(false);
  });
});

describe("chat: polling", () => {
  it("polls every 3 s visible, 15 s hidden, and pauses after 10 minutes idle", () => {
    expect(pollDelay({ visible: true, idleMs: 0 })).toBe(3000);
    expect(pollDelay({ visible: false, idleMs: 0 })).toBe(15000);
    expect(pollDelay({ visible: true, idleMs: IDLE_AFTER_MS })).toBeNull();
  });

  it("announces new messages politely", () => {
    expect(announcement([event({ authorLabel: "Codex" })], false)).toBe("New message from Codex.");
    expect(announcement([event({}), event({})], false)).toBe("2 new messages.");
    const t = event({ authorKind: "threadlink", visibility: "technical", body: "Model used" });
    expect(announcement([t], false)).toBeNull();
  });
});

describe("chat: rendering is plain text only", () => {
  const XSS = "<img src=x onerror=alert(1)>";
  const page: ChatPage = {
    events: [
      event({ body: XSS }),
      event({
        authorKind: "owner",
        authorProvider: null,
        authorLabel: "You",
        eventType: "message",
        body: `<script>alert(1)</script>\n**bold** [link](javascript:alert(1))`,
      }),
      event({
        authorKind: "threadlink",
        authorProvider: null,
        authorLabel: "ThreadLink",
        eventType: "job_started",
        body: `<a href="javascript:alert(1)">Job started</a>`,
      }),
    ],
    cursor: 3,
    activeJob: null,
  };
  const html = renderToStaticMarkup(
    createElement(ProjectChat, {
      roomId: ROOM,
      initial: page,
      controller: "ChatGPT",
      twoAgents: true,
      archived: false,
    }),
  );

  it("escapes HTML in bodies instead of rendering it", () => {
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toMatch(/href="javascript:/);
  });

  it("does not turn markdown into HTML", () => {
    expect(html).toContain("**bold**");
    expect(html).not.toContain("<strong>bold</strong>");
  });

  it("offers the mode picker and mention hints when no job is running", () => {
    expect(html).toContain("Builder + Reviewer");
    expect(html).toContain("@team stop after this review round");
    expect(html).toContain("Starts a new job in this project.");
    expect(html).toMatch(/aria-live="polite"/);
  });

  it("says the message goes to the running job when one is active", () => {
    const running = renderToStaticMarkup(
      createElement(ProjectChat, {
        roomId: ROOM,
        initial: { ...page, activeJob: { jobId: JOB, mode: "team", status: "building" } },
        controller: "ChatGPT",
        twoAgents: true,
        archived: false,
      }),
    );
    expect(running).toContain("Your message goes to the running job");
    expect(running).not.toContain("How to run it");
  });

  it("explains how to start without assuming ChatGPT", () => {
    const empty = renderToStaticMarkup(
      createElement(ProjectChat, {
        roomId: ROOM,
        initial: { events: [], cursor: 0, activeJob: null },
        controller: "your controller (for example ChatGPT)",
        twoAgents: false,
        archived: false,
      }),
    );
    expect(empty).toContain("No messages yet");
    expect(empty).toContain("@Claude");
    expect(empty).toContain("ask your controller (for example ChatGPT)");
    expect(empty).not.toContain("Ask ChatGPT");
  });
});

describe("owner actions always say what happened", () => {
  const fd = new FormData();

  it("passes a result through, and reports a thrown action as a plain failure", async () => {
    await expect(runAction(async () => saved("Plan saved."), fd)).resolves.toEqual({
      ok: true,
      message: "Plan saved.",
    });
    await expect(runAction(async () => failed("Could not save."), fd)).resolves.toEqual({
      ok: false,
      message: "Could not save.",
    });
    const thrown = await runAction(async () => {
      throw new Error('relation "provider_profiles" does not exist');
    }, fd);
    expect(thrown.ok).toBe(false);
    expect(thrown.message).not.toMatch(/relation|provider_profiles/);
    await expect(runAction(async () => undefined, fd, "Done.")).resolves.toEqual({
      ok: true,
      message: "Done.",
    });
    const odd = await runAction(async () => ({ nope: 1 }) as never, fd);
    expect(odd.ok).toBe(false);
  });

  it("renders failures as alerts and successes as status", () => {
    expect(
      renderToStaticMarkup(createElement(ActionStatus, { state: failed("Failed to save") })),
    ).toMatch(/role="alert"[^>]*>Failed to save</);
    expect(renderToStaticMarkup(createElement(ActionStatus, { state: saved() }))).toMatch(
      /role="status"[^>]*>Saved</,
    );
  });
});

describe("project page model", () => {
  const room: OwnerRoom = {
    roomId: ROOM,
    name: "Prism",
    status: "active",
    statusLabel: "Active",
    workspaceName: "C:/Users/joel/code/prism",
    agentName: "Claude Code · Prism build",
    usagePolicy: "balanced",
    budgets: { parallelAgents: 2, maxPlanningRounds: 3, maxReviewRounds: 3 },
    jobs: { total: 2, open: 1, passed: 1, needsAttention: 0 },
    lastJob: null,
    createdAt: "2026-09-20T12:00:00Z",
    updatedAt: "2026-09-25T11:00:00Z",
  };
  const job = (jobId: string, finished: boolean): OwnerJobSummary => ({
    jobId,
    goal: finished ? "Old work" : "Add a health check",
    status: finished ? "completed" : "building",
    statusLabel: "",
    line: null,
    verdict: finished ? "PASS" : null,
    finished,
    planning: "Round 1 of 3",
    review: "Round 0 of 3",
    startedAt: finished ? "2026-09-24T12:00:00Z" : "2026-09-25T11:30:00Z",
    finishedAt: finished ? "2026-09-24T13:00:00Z" : null,
  });
  const jobs = [job(JOB, false), job(JOB_OLD, true)];
  const NOW = Date.parse("2026-09-25T12:00:00Z");

  it("has no raw identifiers in the view; ids live in handles and technical only", () => {
    const m = deriveProject(room, jobs, null, NOW);
    expect(JSON.stringify(m.view)).not.toMatch(ID);
    expect(JSON.stringify(m.view)).not.toContain("C:/Users");
    expect(m.handles.room).toEqual({ roomId: ROOM });
    expect(m.technical.roomId).toBe(ROOM);
    expect(m.technical.jobs.map((j) => j.jobId)).toEqual([JOB, JOB_OLD]);
  });

  it("selects the asked job only if it belongs to this project", () => {
    expect(deriveProject(room, jobs, null, NOW, { job: JOB_OLD }).selectedJobId).toBe(JOB_OLD);
    const other = deriveProject(room, jobs, null, NOW, { job: `tljob_${hex(99)}` });
    expect(other.selectedJobId).toBe(JOB);
    expect(other.view.jobNotFound).toBe(true);
    expect(deriveProject(room, [], null, NOW).selectedJobId).toBeNull();
  });

  it("parses tabs and builds links", () => {
    expect(parseTab(undefined)).toBe("chat");
    expect(parseTab("progress")).toBe("progress");
    expect(parseTab("evil")).toBe("chat");
    expect(parseJobParam("tljob_abc")).toBe("tljob_abc");
    expect(parseJobParam("../x")).toBeNull();
    expect(projectHref(ROOM)).toBe(`/dashboard/projects/${ROOM}`);
    expect(projectHref(ROOM, { tab: "chat", job: JOB })).toBe(
      `/dashboard/projects/${ROOM}?tab=chat&job=${JOB}`,
    );
    expect(projectHref(ROOM, { tab: "progress", job: JOB, extra: { f: "2" } })).toBe(
      `/dashboard/projects/${ROOM}?tab=progress&job=${JOB}&f=2`,
    );
  });
});

describe("verdict colour", () => {
  it("is green only for a PASS the server wrote first", async () => {
    const { verdictTone } = await import("@/lib/dashboard/chat");
    expect(verdictTone("Result: PASS")).toBe("success");
    expect(verdictTone("Result: PASS\nBuilt by Codex.")).toBe("success");
    expect(verdictTone("Result: NEEDS_FIX\nResult: PASS")).toBe("danger");
    expect(verdictTone("Result: BLOCKED")).toBe("danger");
    expect(verdictTone("Result: NEEDS_USER_DECISION")).toBe("warning");
    expect(verdictTone("Result: PASSED maybe")).toBe("warning");
  });
});
