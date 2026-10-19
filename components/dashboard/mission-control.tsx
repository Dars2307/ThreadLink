"use client";

import { useEffect, useRef, useState } from "react";

import { useSupabaseBrowserClient } from "@/lib/supabase/browser";
import { cx } from "@/components/ui";

type TaskEvent = {
  id: string;
  task_id: string;
  created_at: string;
  speaker: "user" | "chatgpt" | "claude_code" | "system";
  event_type: string;
  content: string | null;
  payload: Record<string, unknown> | null;
};

const SPEAKER_LABEL: Record<TaskEvent["speaker"], string> = {
  user: "User",
  chatgpt: "ChatGPT",
  claude_code: "Claude Code",
  system: "System",
};

const SPEAKER_STYLES: Record<TaskEvent["speaker"], { dot: string; label: string; bubble: string }> = {
  user: {
    dot: "bg-accent",
    label: "text-accent",
    bubble: "bg-accent-soft text-foreground",
  },
  chatgpt: {
    dot: "bg-success",
    label: "text-success",
    bubble: "bg-success-soft text-foreground",
  },
  claude_code: {
    dot: "bg-warning",
    label: "text-warning",
    bubble: "bg-warning-soft text-foreground",
  },
  system: {
    dot: "bg-subtle",
    label: "text-muted",
    bubble: "bg-surface-muted text-muted",
  },
};

const EVENT_LABEL: Record<string, string> = {
  task_started: "Task started",
  task_completed: "Task completed",
  task_failed: "Task failed",
};

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "";
  }
}

function EventRow({ event }: { event: TaskEvent }) {
  const s = SPEAKER_STYLES[event.speaker];
  const label = EVENT_LABEL[event.event_type] ?? event.event_type.replace(/_/g, " ");
  return (
    <li className="flex gap-3 py-2">
      <div className="mt-1.5 flex-none">
        <span className={cx("block size-2 rounded-full", s.dot)} aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className={cx("text-xs font-semibold", s.label)}>
            {SPEAKER_LABEL[event.speaker]}
          </span>
          <span className="text-muted text-xs">{label}</span>
          <span className="text-subtle ml-auto text-xs tabular-nums">{formatTime(event.created_at)}</span>
        </div>
        {event.content ? (
          <p className={cx("mt-1 rounded-lg px-3 py-2 text-sm", s.bubble)}>{event.content}</p>
        ) : null}
      </div>
    </li>
  );
}

export function MissionControlFeed({ taskId }: { taskId: string }) {
  const supabase = useSupabaseBrowserClient();
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [live, setLive] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Initial load.
  useEffect(() => {
    let cancelled = false;
    supabase
      .from("task_events")
      .select("id, task_id, created_at, speaker, event_type, content, payload")
      .eq("task_id", taskId)
      .order("created_at", { ascending: true })
      .then(({ data }) => {
        if (!cancelled) {
          setEvents((data as TaskEvent[]) ?? []);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [supabase, taskId]);

  // Realtime subscription.
  useEffect(() => {
    const channel = supabase
      .channel(`mc:${taskId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "task_events",
          filter: `task_id=eq.${taskId}`,
        },
        (payload) => {
          setEvents((prev) => [...prev, payload.new as TaskEvent]);
        },
      )
      .subscribe((status) => {
        setLive(status === "SUBSCRIBED");
      });
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [supabase, taskId]);

  // Auto-scroll to bottom when new events arrive.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold tracking-tight">Mission Control</h2>
        <span className="flex items-center gap-1.5 text-xs">
          {live ? (
            <>
              <span className="relative inline-flex size-2">
                <span className="tl-ping absolute inset-0 rounded-full bg-success" aria-hidden />
                <span className="relative inline-flex size-2 rounded-full bg-success" aria-hidden />
              </span>
              <span className="text-success">Live</span>
            </>
          ) : (
            <>
              <span className="size-2 rounded-full bg-subtle" aria-hidden />
              <span className="text-muted">Connecting…</span>
            </>
          )}
        </span>
      </div>

      <div className="border-border bg-surface rounded-2xl border">
        {loading ? (
          <p className="text-muted px-5 py-6 text-center text-sm">Loading events…</p>
        ) : events.length === 0 ? (
          <p className="text-muted px-5 py-6 text-center text-sm">
            Waiting for activity. Events appear here as the runtime works on this task.
          </p>
        ) : (
          <ul
            className="divide-border max-h-[28rem] divide-y overflow-y-auto px-5 py-4"
            aria-label="Task events"
          >
            {events.map((e) => (
              <EventRow key={e.id} event={e} />
            ))}
            <div ref={bottomRef} aria-hidden />
          </ul>
        )}
      </div>
    </div>
  );
}
