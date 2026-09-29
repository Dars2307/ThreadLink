import { describe, expect, it } from "vitest";

import {
  ACTIVITY_THREADLINK_TYPES,
  agentAvatar,
  agentFullName,
  agentShortName,
  CHAT_THREADLINK_TYPES,
  chatPlacement,
  durationText,
  failoverText,
  hostOfflineNote,
  hostPresence,
  hostPresenceLabel,
  humanSystemText,
  isApprovalKind,
  parsePresence,
  parseRunTimings,
  resetsAtOf,
  resetTimeText,
  runTimingsText,
  scrubSystemText,
  serviceLabel,
  timingBreakdown,
  visibleChoiceOptions,
  youPresence,
  youPresenceLabel,
  type PresentationEvent,
} from "../runtime/src/chat-presentation.ts";

const tl = (eventType: string, extra: Partial<PresentationEvent> = {}): PresentationEvent => ({
  authorKind: "threadlink",
  eventType,
  visibility: "visible",
  body: "",
  ...extra,
});

describe("chatPlacement (§7)", () => {
  it("keeps people and agents in the chat", () => {
    expect(chatPlacement({ authorKind: "owner", eventType: "message" })).toBe("chat");
    expect(chatPlacement({ authorKind: "controller", eventType: "request" })).toBe("chat");
    expect(chatPlacement({ authorKind: "agent", eventType: "agent_message" })).toBe("chat");
    expect(chatPlacement({ authorKind: "agent", eventType: "agent_result" })).toBe("chat");
    expect(chatPlacement({ authorKind: "agent", eventType: "code_change" })).toBe("chat");
  });

  it("sends everything technical to activity, even messages", () => {
    expect(
      chatPlacement({ authorKind: "agent", eventType: "agent_message", visibility: "technical" }),
    ).toBe("activity");
    expect(chatPlacement(tl("choice", { visibility: "technical" }))).toBe("activity");
  });

  it.each([
    "provider_blocked",
    "choice",
    "timeout",
    "interrupted",
    "job_summary",
    "job_verdict",
    "plan_agreed",
    "mode_changed",
    "failover",
    "code_change",
  ])("ThreadLink %s is chat", (t) => {
    expect(chatPlacement(tl(t))).toBe("chat");
  });

  it.each([
    "job_started",
    "phase",
    "unit_status",
    "task_started",
    "task_progress",
    "task_completed",
    "task_failed",
    "task_cancelled",
    "model_used",
    "model_mismatch",
    "owner_routed",
    "stop_requested",
    "control_requested",
    "run_started",
    "run_finished",
    "something_new_in_0_12",
  ])("ThreadLink %s is activity", (t) => {
    expect(chatPlacement(tl(t))).toBe("activity");
  });

  it("the chat and activity lists never overlap", () => {
    const overlap = CHAT_THREADLINK_TYPES.filter((t) => ACTIVITY_THREADLINK_TYPES.includes(t));
    expect(overlap).toEqual([]);
  });

  it("job_status: only work-stopping rows reach the chat (0.10 bodies and payloads)", () => {
    expect(chatPlacement(tl("job_status", { body: "Status: Building" }))).toBe("activity");
    expect(chatPlacement(tl("job_status", { body: "The job failed." }))).toBe("chat");
    expect(chatPlacement(tl("job_status", { body: "The job was cancelled." }))).toBe("chat");
    expect(chatPlacement(tl("job_status", { payload: { status: "failed" } }))).toBe("chat");
  });

  it("findings: blocking/important and open only; minor, fixed and status updates are activity", () => {
    const blocking = tl("finding", { payload: { severity: "blocking", status: "open" } });
    expect(chatPlacement(blocking)).toBe("chat");
    expect(chatPlacement(tl("finding", { payload: { severity: "important" } }))).toBe("chat");
    expect(chatPlacement(tl("finding", { payload: { severity: "non_blocking" } }))).toBe(
      "activity",
    );
    expect(chatPlacement(blocking, { findingStatus: "fixed" })).toBe("activity");
    expect(chatPlacement(blocking, { findingStatus: "dismissed" })).toBe("activity");
    expect(chatPlacement(blocking, { findingStatus: "disputed" })).toBe("chat");
    expect(chatPlacement(blocking, { firstFindingRow: false })).toBe("activity");
    // A row without payload (terminal client): the trusted body prefix decides.
    expect(chatPlacement(tl("finding", { body: "Blocking finding from Codex (security)" }))).toBe(
      "chat",
    );
    expect(chatPlacement(tl("finding", { body: "Minor finding from Codex (style)" }))).toBe(
      "activity",
    );
  });

  it("decisions: only the ones that need the owner", () => {
    expect(chatPlacement(tl("decision", { body: "Decision TL-00001" }))).toBe("activity");
    expect(
      chatPlacement(tl("decision", { body: "Decision TL-00002\nThis needs your decision." })),
    ).toBe("chat");
    expect(chatPlacement(tl("decision_card", { payload: { requiresUser: true } }))).toBe("chat");
    expect(
      chatPlacement({
        authorKind: "agent",
        eventType: "decision_card",
        payload: { requiresUser: false },
      }),
    ).toBe("activity");
  });

  it("0.11 choice kinds are chat", () => {
    expect(chatPlacement(tl("choice", { payload: { kind: "usage_exhausted" } }))).toBe("chat");
    expect(chatPlacement(tl("choice", { payload: { kind: "start_work" } }))).toBe("chat");
  });

  it("an old 0.10 heavy job reads as a quiet conversation", () => {
    const rows: PresentationEvent[] = [
      { authorKind: "owner", eventType: "message", body: "@team fix login" },
      tl("job_started", { body: "Team Mode job started." }),
      tl("phase", { payload: { phase: "planning" } }),
      tl("job_status", { body: "Status: Planning", visibility: "technical" }),
      { authorKind: "agent", eventType: "agent_message", body: "Plan: …" },
      tl("decision", { body: "Decision TL-00003" }),
      tl("plan_agreed", { body: "Plan agreed. Building now." }),
      tl("unit_status", { body: "Unit auth started" }),
      tl("task_started", { body: "Codex started building" }),
      tl("model_used", { body: "Codex used GPT-6" }),
      { authorKind: "agent", eventType: "code_change", body: "3 files" },
      tl("job_verdict", { body: "Result: PASS" }),
      tl("job_summary", { body: "Summary" }),
    ];
    const chat = rows.filter((r) => chatPlacement(r) === "chat").map((r) => r.eventType);
    expect(chat).toEqual([
      "message",
      "agent_message",
      "plan_agreed",
      "code_change",
      "job_verdict",
      "job_summary",
    ]);
  });

  it("approval kinds are recognised", () => {
    expect(isApprovalKind("migration")).toBe(true);
    expect(isApprovalKind("usage_exhausted")).toBe(false);
    expect(isApprovalKind(null)).toBe(false);
  });
});

describe("agent names", () => {
  it("short names", () => {
    expect(agentShortName("claude-code")).toBe("Claude");
    expect(agentShortName("codex")).toBe("Codex");
    expect(agentShortName("CODEX")).toBe("Codex");
    expect(agentShortName("future-agent", "Nova")).toBe("Nova");
    expect(agentShortName("gemini-cli")).toBe("Gemini");
    expect(agentShortName("acme-bot")).toBe("Acme");
    expect(agentShortName(null)).toBe("Agent");
    expect(agentShortName("")).toBe("Agent");
  });
  it("full names only when asked", () => {
    expect(agentFullName("claude-code")).toBe("Claude Code");
    expect(agentFullName("codex")).toBe("Codex");
    expect(agentFullName("x", "Registry Name")).toBe("Registry Name");
  });
});

describe("humanSystemText", () => {
  it("never shows ids or reason codes", () => {
    const out = humanSystemText(
      tl("provider_blocked", {
        body: "Codex usage_exhausted (run 0f8c2a3e-1b2c-4d5e-8f90-123456789abc) job_AbCdEf12 TL-00042",
      }),
    );
    expect(out).toBe("Codex usage limit reached (run)");
    expect(out).not.toMatch(/[0-9a-f]{8}-|TL-|job_|_/);
  });

  it("status and decision rows in words", () => {
    expect(humanSystemText(tl("job_status", { body: "Status: plan_review" }))).toBe(
      "Reviewing the plan",
    );
    expect(humanSystemText(tl("decision", { body: "Decision TL-00001" }))).toBe(
      "Decision recorded.",
    );
    expect(
      humanSystemText(tl("decision", { body: "Decision TL-00002\nThis needs your decision." })),
    ).toBe("A decision needs you.");
    expect(humanSystemText(tl("phase", { payload: { phase: "building" } }))).toBe("Building");
  });

  it("failover notices", () => {
    expect(
      humanSystemText(
        tl("failover", {
          body: "failover codex->claude-code",
          payload: { from: "codex", to: "claude-code", reviewWaits: true },
        }),
      ),
    ).toBe(
      "Codex usage is exhausted. Continuing with Claude. Independent review will wait for Codex.",
    );
    expect(failoverText({ from: "codex", to: "claude-code" })).toBe(
      "Codex usage is exhausted. Continuing with Claude.",
    );
    expect(failoverText({ from: "codex", reason: "needs_sign_in" })).toBe("Codex is unavailable.");
  });

  it("leaves agent and owner text alone", () => {
    const body = "use snake_case and job_12345678";
    expect(humanSystemText({ authorKind: "agent", eventType: "agent_message", body })).toBe(body);
    expect(humanSystemText({ authorKind: "owner", eventType: "message", body })).toBe(body);
  });

  it("scrubs but never returns empty", () => {
    expect(humanSystemText(tl("job_started", { body: "TL-00001" }))).toBe("Update");
    expect(scrubSystemText("a  b\n\n\n\nc")).toBe("a b\n\nc");
  });
});

describe("choices", () => {
  const opts = [
    { key: "continue_other", label: "Continue with Claude" },
    { key: "check_again", label: "Check Codex again" },
    { key: "retry", label: "Retry Codex" },
    { key: "wait", label: "Wait for Codex" },
    { key: "stop", label: "Stop" },
  ];
  it("usage_exhausted never offers retry", () => {
    expect(visibleChoiceOptions("usage_exhausted", opts).map((o) => o.label)).toEqual([
      "Continue with Claude",
      "Check Codex again",
      "Wait for Codex",
      "Stop",
    ]);
  });
  it("provider_failure keeps retry unless the provider is exhausted", () => {
    expect(visibleChoiceOptions("provider_failure", opts)).toHaveLength(5);
    expect(
      visibleChoiceOptions("provider_failure", opts, { providerExhausted: true }),
    ).toHaveLength(4);
  });
  it("resetsAt is read, never invented", () => {
    expect(resetsAtOf({ resetsAt: "2026-09-29T14:52:00Z" })).toBe("2026-09-29T14:52:00Z");
    expect(resetsAtOf(null, { params: { resetsAt: "2026-09-29T14:52:00Z" } })).toBe(
      "2026-09-29T14:52:00Z",
    );
    expect(resetsAtOf({ resetsAt: "soon" })).toBeNull();
    expect(resetsAtOf({})).toBeNull();
  });
  it("reset time in the viewer's time zone", () => {
    const now = Date.parse("2026-09-29T12:00:00Z");
    expect(resetTimeText("2026-09-29T14:52:00Z", { timeZone: "UTC", now })).toBe(
      "Resets around 14:52",
    );
    expect(resetTimeText("2026-09-29T14:52:00Z", { timeZone: "Europe/Berlin", now })).toBe(
      "Resets around 16:52",
    );
    expect(resetTimeText("2026-10-02T09:05:00Z", { timeZone: "UTC", now })).toBe(
      "Resets around Fri 09:05",
    );
    expect(resetTimeText(null)).toBe("Reset time not reported.");
    expect(resetTimeText("garbage")).toBe("Reset time not reported.");
  });
});

describe("timings", () => {
  it("durations", () => {
    expect(durationText(800)).toBe("0.8 s");
    expect(durationText(34_000)).toBe("34 s");
    expect(durationText(125_000)).toBe("2 min 5 s");
    expect(durationText(3_600_000)).toBe("1 h");
    expect(durationText(-1)).toBe("—");
  });
  it("run timings line", () => {
    const t = parseRunTimings({
      queueMs: 1200,
      spawnMs: 500,
      contextMs: 300,
      providerMs: 34_000,
      persistMs: 200,
      junk: "x",
    });
    expect(runTimingsText(t)).toBe("Pickup 1.2 s · Startup 0.8 s · Provider 34 s · Persist 0.2 s");
    expect(runTimingsText(parseRunTimings({ providerMs: 2000, firstEventMs: 900 }))).toBe(
      "First output 0.9 s · Provider 2.0 s",
    );
    expect(parseRunTimings({ queueMs: "1" })).toBeNull();
    expect(parseRunTimings(null)).toBeNull();
    expect(runTimingsText(null)).toBeNull();
  });
});

describe("presence (§4)", () => {
  const now = Date.parse("2026-09-29T12:00:00Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it("parses only known values", () => {
    expect(parsePresence("working")).toBe("working");
    expect(parsePresence("away")).toBeNull();
  });

  it("server presence wins, but fresh work is never offline", () => {
    expect(hostPresence({ presence: "online", now })).toBe("online");
    expect(hostPresence({ presence: "offline", now })).toBe("offline");
    expect(hostPresence({ presence: "offline", now, lastActivityAt: ago(60_000) })).toBe("working");
    expect(hostPresence({ presence: "reconnecting", now, working: true })).toBe("working");
    expect(hostPresence({ presence: "offline", now, lastActivityAt: ago(4 * 60_000) })).toBe(
      "offline",
    );
    expect(hostPresence({ presence: "working", now, revoked: true })).toBe("offline");
  });

  it("ages lastSeenAt against the server clock when the server has no presence v2", () => {
    const serverNow = new Date(now).toISOString();
    expect(hostPresence({ lastSeenAt: ago(30_000), serverNow, now: now + 999_999 })).toBe("online");
    expect(hostPresence({ lastSeenAt: ago(75_000), serverNow, now })).toBe("reconnecting");
    expect(hostPresence({ lastSeenAt: ago(3 * 60_000), serverNow, now })).toBe("offline");
    expect(hostPresence({ now })).toBe("offline");
  });

  it("labels", () => {
    expect(hostPresenceLabel("Nickron PC", "working").text).toBe("Nickron PC · Working");
    expect(hostPresenceLabel(null, "online").text).toBe("Your computer · Online");
    expect(hostOfflineNote("Nickron PC", "offline")).toBe(
      "You're connected. Nickron PC is offline — repository work and agent replies will resume when it reconnects.",
    );
    expect(hostOfflineNote("Nickron PC", "reconnecting")).toBeNull();
  });

  it("You comes from this client's own requests, never from the host", () => {
    expect(youPresence({ consecutiveFailures: 0 })).toBe("connected");
    expect(youPresence({ consecutiveFailures: 2 })).toBe("reconnecting");
    expect(youPresence({ consecutiveFailures: 0, browserOnline: false })).toBe("offline");
    expect(youPresenceLabel("connected").text).toBe("You · Connected");
    expect(youPresenceLabel("reconnecting").text).toBe("You · Reconnecting");
    expect(serviceLabel({ consecutiveFailures: 0 }).text).toBe("ThreadLink service · Reachable");
    expect(serviceLabel({ consecutiveFailures: 1 }).text).toBe("ThreadLink service · Reconnecting");
  });
});

describe("scrubSystemText: ThreadLink-owned ids", () => {
  it("removes tljob_/tlrun_/tlses_ ids", async () => {
    const { scrubSystemText } = await import("../runtime/src/chat-presentation.ts");
    expect(
      scrubSystemText("Job tljob_34356546207545ef89c23ef1d694c2f3 run tlrun_abcdef123456 done."),
    ).toBe("Job run done.");
  });
});

describe("design canvas helpers", () => {
  it("avatars: Claude C, Codex X, others their initial", () => {
    expect(agentAvatar("claude-code")).toEqual({ initial: "C", kind: "claude" });
    expect(agentAvatar("codex")).toEqual({ initial: "X", kind: "codex" });
    expect(agentAvatar("nova-x", "Nova")).toEqual({ initial: "N", kind: "other" });
  });
  it("where the time went", () => {
    const parts = timingBreakdown(
      { queueMs: 900, spawnMs: 600, contextMs: 500, providerMs: 48_000, persistMs: 300 },
      "Codex",
    );
    expect(parts.map((p) => [p.label, durationText(p.ms)])).toEqual([
      ["Waiting for the computer", "0.9 s"],
      ["Startup", "1.1 s"],
      ["Codex working", "48 s"],
      ["Saving", "0.3 s"],
    ]);
    expect(parts.map((p) => p.percent)).toEqual([2, 2, 95, 1]);
    expect(timingBreakdown({ providerMs: 2000 }, "Claude")).toEqual([
      { key: "provider", label: "Claude working", ms: 2000, percent: 100 },
    ]);
    expect(timingBreakdown(null, "x")).toEqual([]);
  });
});
