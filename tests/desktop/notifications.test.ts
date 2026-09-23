import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_PREFERENCES,
  NotificationRouter,
  toPayload,
  type NotificationChannel,
  type NotificationPayload,
} from "../../desktop/src/notifications.ts";

/**
 * The router is the only thing that decides whether a state is worth
 * interrupting someone for, and what may appear on a lock screen. Both are
 * easy to get wrong quietly, so both are pinned here.
 */

function recorder(id = "test", available = true) {
  const sent: NotificationPayload[] = [];
  const channel: NotificationChannel = {
    id,
    available: () => available,
    deliver: (p) => sent.push(p),
  };
  return { channel, sent };
}

const completed = {
  type: "task",
  outcome: "completed",
  title: "Phase 6.7",
  conversation: "ThreadLink",
};
const failed = { type: "task", outcome: "failed", title: "Phase 6.7", conversation: "ThreadLink" };

describe("what is worth a notification", () => {
  it("notifies on the meaningful states", () => {
    expect(toPayload(completed)?.event).toBe("task_completed");
    expect(toPayload(failed)?.event).toBe("task_failed");
    expect(toPayload({ type: "link-request", link: { from: "ChatGPT" } })?.event).toBe(
      "approval_required",
    );
  });

  it("stays silent for progress, polling and housekeeping", () => {
    for (const event of [
      { type: "task", outcome: "lost", title: "x" },
      { type: "snapshot" },
      { type: "settings" },
      { type: "restart-requested" },
      { type: "progress", title: "thinking" },
    ]) {
      expect(toPayload(event), JSON.stringify(event)).toBeNull();
    }
  });

  it("says plainly when a conversation was in use, or cannot work in the background", () => {
    expect(toPayload({ ...failed, reason: "session_busy" })?.title).toBe(
      "Claude conversation is in use",
    );
    expect(toPayload({ ...failed, reason: "background_mode_unsupported" })?.title).toBe(
      "That agent cannot work in the background",
    );
  });
});

describe("what a notification may say", () => {
  it("carries only the task name and where it ran", () => {
    const payload = toPayload(completed)!;
    expect(payload.title).toBe("Claude finished");
    expect(payload.body).toBe("Phase 6.7 · ThreadLink");
  });

  it("never carries the prompt, the result or anything secret", () => {
    // Even if an engine event were to arrive carrying content, the payload is
    // built only from the fields the router chooses.
    const payload = toPayload({
      ...completed,
      // @ts-expect-error - deliberately passing fields the router must ignore
      content: "export const API_KEY = 'sk-live-should-never-appear'",
      result: "diff --git a/secrets.ts",
    })!;
    const text = JSON.stringify(payload);
    expect(text).not.toContain("sk-live");
    expect(text).not.toContain("diff --git");
  });

  it("strips control characters and caps a very long title", () => {
    const payload = toPayload({
      type: "task",
      outcome: "completed",
      title: `bad\u0000title\u001b[31m${"x".repeat(200)}`,
      conversation: "ws",
    })!;
    expect(payload.body).not.toMatch(/[\u0000-\u001f]/);
    expect(payload.body.length).toBeLessThanOrEqual(90);
  });
});

describe("delivery", () => {
  it("delivers a meaningful event to every available channel", () => {
    const a = recorder("a");
    const b = recorder("b");
    const router = new NotificationRouter();
    router.register(a.channel);
    router.register(b.channel);
    expect(router.handle(completed)).not.toBeNull();
    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(1);
  });

  it("skips a channel that exists but cannot deliver", () => {
    const off = recorder("email", false);
    const router = new NotificationRouter();
    router.register(off.channel);
    router.handle(completed);
    expect(off.sent).toHaveLength(0);
    expect(router.channels()).toEqual([{ id: "email", available: false }]);
  });

  it("does not notify twice for the same state", () => {
    const a = recorder();
    const router = new NotificationRouter();
    router.register(a.channel);
    expect(router.handle(completed)).not.toBeNull();
    expect(router.handle(completed)).toBeNull();
    expect(router.handle(completed)).toBeNull();
    expect(a.sent).toHaveLength(1);
  });

  it("allows the same state again once the dedupe window has passed", () => {
    let now = 1_000;
    const a = recorder();
    const router = new NotificationRouter({ dedupeMs: 1000, now: () => now });
    router.register(a.channel);
    router.handle(completed);
    now += 999;
    expect(router.handle(completed)).toBeNull();
    now += 2;
    expect(router.handle(completed)).not.toBeNull();
    expect(a.sent).toHaveLength(2);
  });

  it("treats different tasks as different notifications", () => {
    const a = recorder();
    const router = new NotificationRouter();
    router.register(a.channel);
    router.handle(completed);
    router.handle({ ...completed, title: "Another task" });
    expect(a.sent).toHaveLength(2);
  });

  it("groups a burst of the same kind under one coalesce key", () => {
    const first = toPayload(completed)!;
    const second = toPayload({ ...completed, title: "Second" })!;
    expect(first.coalesceKey).toBe(second.coalesceKey);
    expect(toPayload(failed)!.coalesceKey).not.toBe(first.coalesceKey);
  });

  it("respects the user turning a state off", () => {
    const a = recorder();
    const router = new NotificationRouter({
      preferences: { ...DEFAULT_PREFERENCES, onCompleted: false },
    });
    router.register(a.channel);
    expect(router.handle(completed)).toBeNull();
    expect(router.handle(failed)).not.toBeNull();
    expect(a.sent).toHaveLength(1);
  });

  it("keeps working when a channel throws", () => {
    const good = recorder("good");
    const router = new NotificationRouter();
    router.register({
      id: "broken",
      available: () => true,
      deliver: () => {
        throw new Error("channel exploded");
      },
    });
    router.register(good.channel);
    expect(() => router.handle(completed)).not.toThrow();
    expect(good.sent).toHaveLength(1);
  });

  it("points each event at the page that answers it", () => {
    expect(toPayload({ type: "link-request", link: { from: "ChatGPT" } })!.openPath).toBe(
      "/dashboard/links",
    );
    expect(toPayload(completed)!.openPath).toBe("/dashboard/activity");
  });
});

describe("preferences", () => {
  it("can be changed after construction", () => {
    const a = recorder();
    const router = new NotificationRouter();
    router.register(a.channel);
    router.setPreferences({ onFailed: false });
    expect(router.handle(failed)).toBeNull();
    expect(a.sent).toHaveLength(0);
  });
});

describe("channel availability is honest", () => {
  it("reports an unconfigured channel as unavailable rather than pretending", () => {
    const router = new NotificationRouter();
    const email: NotificationChannel = {
      id: "email",
      // No per-user credential exists yet; the channel says so.
      available: () => false,
      deliver: vi.fn(),
    };
    router.register(email);
    router.handle(completed);
    expect(email.deliver).not.toHaveBeenCalled();
    expect(router.channels()).toContainEqual({ id: "email", available: false });
  });
});
