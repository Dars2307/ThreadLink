/**
 * Fast Chat (docs/design/threadlink-0.11.md §3.4): the `chat` lane.
 *
 * A chat-lane job is a conversational turn, not engineering work: no
 * normalise / plan / review / integrate / inspect, no worktree, no DAG, no
 * verdict. Per job:
 *
 *   1. Scoped context: this chat's recent messages (read_chat_context), the
 *      participants and the project name. Nothing from any other chat.
 *   2. Responders: from the job (the server resolved @mentions and the mode).
 *      An agent that is out of usage or not signed in is skipped; at most one
 *      quiet ThreadLink notice per chat per exhaustion (failover_notice).
 *   3. First turns run concurrently. Each answer is posted the moment it
 *      returns (run_started → add_message with the run → run_finished).
 *   4. One bounded follow-up round (FAST_CHAT_MAX_FOLLOWUPS, default 1, hard
 *      cap 2) when two or more agents answered and it is not small talk. An
 *      agent that has nothing materially new returns an empty message and
 *      nothing is posted. Replies point at what they answer.
 *   5. Providers run read-only in the project folder (Claude plan mode, Codex
 *      read-only sandbox), with the stripped environment and subscription
 *      sign-in of every Team run; the model is verified exactly as in 0.10.
 *   6. One native session per (chat, provider, workspace), resumed on the next
 *      turn and rotated after 30 turns / 24 h / a failed resume.
 *   7. An answer may say the request needs real work (`needsWork`): ThreadLink
 *      then offers "Run this as work" (choice `start_work`), and nothing else.
 *
 * Stop (stop_now / cancel_queued) aborts every run of the job at once.
 * Everything is injected, so each rule is testable with fake runners.
 */

import { spawn } from "node:child_process";

import { redactText } from "../summary.ts";
import { capabilitiesOf, type ProviderCapabilities } from "./capabilities.ts";
import type { ChatSessionStore } from "./chat-sessions.ts";
import { handleExhausted, sendFailoverNotice, type FailoverDeps } from "./failover.ts";
import type { ProviderHealth } from "./health.ts";
import type { TeamJobDefinition } from "./job.ts";
import type {
  AgentRunner,
  AgentRunResult,
  RouteRequest,
  RouteResult,
  StateSink,
  TeamOp,
} from "./orchestrator.ts";
import { block, INJECTION_RULE } from "./prompts.ts";
import type { ProcessRegistry } from "./registry.ts";
import { PROVIDER_NAME } from "./roles.ts";
import type { AgentProvider } from "./types.ts";
import {
  messagePayload,
  OPS_0_10,
  OPS_0_11,
  parseChatContext,
  parseControl,
  parseMessageId,
  parseRunId,
  readChatContextPayload,
  readChoicesPayload,
  requestChoicePayload,
  runFinishedPayload,
  runStartedPayload,
  type ChatContextMessage,
  type RunTimings,
  type SessionReason,
} from "./wire.ts";

export const FAST_CHAT_DEFAULT_FOLLOWUPS = 1;
export const FAST_CHAT_MAX_FOLLOWUPS = 2;
export const FAST_CHAT_CONTEXT_LIMIT = 20;
export const FAST_CHAT_TIMEOUT_MS = 10 * 60_000;
/** How often a running chat turn asks whether the owner pressed Stop (chat turns are short). */
export const CHAT_CONTROL_POLL_MS = 5_000;
/** Chat answers stay short enough to read in a chat. */
export const CHAT_MESSAGE_MAX = 4_000;
const CHAT_ROLE = "investigator" as const;

/** The structured answer every Fast Chat turn gives (Claude --json-schema, Codex --output-schema). */
export const CHAT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["message", "needsWork", "workReason"],
  properties: {
    message: {
      type: "string",
      description:
        "Your reply, posted in the chat under your name: a concise, conversational answer to the " +
        "owner. Not your private reasoning. Empty only when you have nothing to add (follow-ups).",
    },
    needsWork: {
      type: "boolean",
      description:
        "True only if properly answering requires changing the repository or running commands " +
        "such as tests or builds.",
    },
    workReason: {
      type: "string",
      description: "One line: what work is needed. Empty when needsWork is false.",
    },
  },
} as const;

export type ChatAnswer = { message: string; needsWork: boolean; workReason: string };

/** A running work job of the same chat, as ThreadLink itself tracks it (TeamProgress). */
export type ChatWorkStatus = {
  /** One safe line about the job's goal. */
  goal: string;
  /** The job's phase (normalising, planning, building, reviewing, …). */
  status: string;
  /** ThreadLink's latest progress line. */
  line: string;
  /** What each agent is doing in the job now, in ThreadLink's words. */
  agents: { provider: AgentProvider; doing: string }[];
  /** Units of work and where they stand. */
  units: { title: string; owner: AgentProvider; status: string }[];
};

const PHASE_WORDS: Record<string, string> = {
  queued: "waiting to start",
  normalising: "turning the request into a specification",
  planning: "planning",
  building: "building and reviewing the work",
  reviewing: "reviewing",
  integrating: "integrating the work",
  inspecting: "doing the final inspection",
  paused: "paused by the owner",
  interrupted: "interrupted, waiting for the owner",
};

/**
 * The fixed-text status block for a Fast Chat prompt (0.11.1). Only what
 * ThreadLink tracked: phase, progress line, each agent's current step, units.
 * Nothing is estimated or invented.
 */
export function workStatusText(work: ChatWorkStatus, you: AgentProvider): string {
  const lines = [
    `Engineering work the owner asked for is running in this chat right now: ${work.goal.slice(0, 300)}`,
    `Stage: ${PHASE_WORDS[work.status] ?? work.status.replace(/_/g, " ")}.`,
  ];
  if (work.line) lines.push(`Latest ThreadLink status: ${work.line.slice(0, 300)}`);
  for (const a of work.agents.slice(0, 6)) {
    const who = a.provider === you ? `You (${name(a.provider)})` : name(a.provider);
    lines.push(`${who}: ${a.doing.slice(0, 200)}`);
  }
  if (!work.agents.some((a) => a.provider === you)) {
    lines.push(`You (${name(you)}): no step of that job is running for you at this moment.`);
  }
  for (const u of work.units.slice(0, 10)) {
    lines.push(
      `Unit "${u.title.slice(0, 120)}" (owner ${name(u.owner)}): ${u.status.replace(/_/g, " ")}`,
    );
  }
  return lines.join("\n");
}

/** Answers that are not answers (0.10.1 placeholder guard): never posted as an agent's message. */
const PLACEHOLDER =
  /^(?:test(?:ing)?|done|ok(?:ay)?|n\/?a|none|null|placeholder|todo|tbd|\.+|-+|…)\.?$/i;

export function isPlaceholder(text: string): boolean {
  const t = text.trim();
  return t.length === 0 || PLACEHOLDER.test(t);
}

/** Greeting / thanks / acknowledgement only (§2.4 small talk): no follow-up round. */
export function isSmallTalk(text: string): boolean {
  const t = text
    .replace(/@[\w-]+/g, " ")
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .trim()
    .toLowerCase();
  if (!t) return true;
  const words = t.split(/\s+/);
  if (words.length > 6) return false;
  return /^(?:(?:hi|hey|hello|yo|hiya|howdy|morning|evening|afternoon|good|gm|thanks|thank|you|thx|ty|cheers|ok|okay|cool|nice|great|awesome|perfect|got|it|sounds|lgtm|sure|yes|yep|no|nope|team|all|both|guys|everyone|folks|there|bye|see|ya|later|night|much|so|very|appreciated|appreciate|it's|that's|fine|good)\s*)+$/.test(
    t,
  );
}

export type FastChatHealth = {
  /** Cached health only: a Fast Chat turn never waits on a probe. */
  peek(providers: AgentProvider[]): Partial<Record<AgentProvider, ProviderHealth>>;
  /** A fresh authenticated check (Check again / waiting for a reset). */
  recheck?(provider: AgentProvider): Promise<ProviderHealth>;
  noteFailure?(
    provider: AgentProvider,
    failure: NonNullable<AgentRunResult["failure"]>,
    details?: { resetsAt?: string | null },
  ): void;
};

export type FastChatDeps = {
  runners: Partial<Record<AgentProvider, AgentRunner>>;
  route(request: RouteRequest): RouteResult;
  sink: StateSink;
  health?: FastChatHealth;
  sessions?: ChatSessionStore;
  processes?: ProcessRegistry;
  /** A provider ran out of included usage (the Runtime's governor). */
  onExhausted?(provider: AgentProvider, resetsAt: string | null): void;
  /** Governor view: true while a provider is marked exhausted. */
  isExhausted?(provider: AgentProvider): boolean;
  capabilities?: (provider: AgentProvider) => ProviderCapabilities | null;
  /**
   * A fingerprint of the project folder's working tree (git status + HEAD),
   * taken before and after a run whose provider cannot report its own sandbox
   * (Claude). Unchanged → access verified. Null: cannot tell.
   */
  snapshot?: (cwd: string) => Promise<string | null>;
  signal?: AbortSignal;
  clock?: { now(): number; sleep(ms: number, signal: AbortSignal): Promise<void> };
  choicePollMs?: number;
  choiceWaitMs?: number;
  controlPollMs?: number;
  timeoutMs?: number;
  maxFollowups?: number;
  /** Job created → claimed by this Runtime (envelope timestamps), for timings. */
  queueMs?: number | null;
  /** Shared per Runtime: at most one failover notice per chat per exhaustion. */
  noticesSent?: Set<string>;
  /**
   * 0.11.1: the engineering work running in this chat on this Runtime right
   * now (the orchestrator's own progress), or null. Lets an agent asked "what
   * are you doing?" mid-job answer as the teammate it is.
   */
  workInChat?: (chatId: string) => ChatWorkStatus | null;
  log?(message: string): void;
};

export type FastChatOutcome = {
  status: "completed" | "failed" | "cancelled";
  /** Agents whose answer was posted. */
  answered: AgentProvider[];
  /** Messages posted (first turns and follow-ups). */
  posted: number;
  needsWork: boolean;
};

type Posted = { provider: AgentProvider; messageId: string | null; body: string; runKey: string };

type TurnResult =
  | { ok: true; answer: ChatAnswer; posted: Posted | null; runId: string | null }
  | {
      ok: false;
      failure: NonNullable<AgentRunResult["failure"]> | "no_model" | "no_answer";
      resetsAt: string | null;
    };

const realClock = {
  now: () => Date.now(),
  sleep: (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      const t = setTimeout(resolve, ms);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          resolve();
        },
        { once: true },
      );
    }),
};

const UNAVAILABLE: ReadonlySet<ProviderHealth> = new Set([
  "usage_exhausted",
  "needs_sign_in",
  "api_key_auth",
  "not_installed",
]);

const NO_RISK = { security: false, database: false, architecture: false, deployment: false };

function name(provider: AgentProvider): string {
  return PROVIDER_NAME[provider] ?? provider;
}

/** Short names for people in a chat (never ids). */
function shortName(provider: AgentProvider): string {
  return provider === "claude-code" ? "Claude" : provider === "codex" ? "Codex" : name(provider);
}

/** git status + HEAD of a folder, as one string; null outside a repository. */
export function gitSnapshot(cwd: string): Promise<string | null> {
  const run = (args: string[]) =>
    new Promise<string | null>((resolve) => {
      try {
        const child = spawn("git", args, {
          cwd,
          windowsHide: true,
          stdio: ["ignore", "pipe", "ignore"],
        });
        let out = "";
        child.stdout?.on("data", (d: Buffer) => {
          if (out.length < 1_000_000) out += d.toString("utf8");
        });
        child.on("error", () => resolve(null));
        child.on("close", (code) => resolve(code === 0 ? out : null));
      } catch {
        resolve(null);
      }
    });
  return Promise.all([
    run(["rev-parse", "HEAD"]),
    run(["status", "--porcelain=v1", "-uall", "--ignore-submodules"]),
  ]).then(([head, status]) => (head === null || status === null ? null : `${head}\n${status}`));
}

export class FastChatCoordinator {
  readonly #job: TeamJobDefinition;
  readonly #d: FastChatDeps;
  readonly #abort = new AbortController();
  readonly #runKeys = new Set<string>();
  /** This job's sessions per provider (follow-ups resume the first turn's). */
  readonly #jobSessions = new Map<AgentProvider, { sessionId: string; runKey: string }>();
  #stopped = false;
  #lastControlPoll = 0;
  #choicesUnavailable = false;

  constructor(job: TeamJobDefinition, deps: FastChatDeps) {
    this.#job = job;
    this.#d = deps;
    if (deps.signal?.aborted) this.#abort.abort();
    deps.signal?.addEventListener("abort", () => this.#abort.abort(), { once: true });
  }

  get #clock() {
    return this.#d.clock ?? realClock;
  }

  /** Runs the chat turn to completion. Never throws for an ordinary failure. */
  async run(workspace: string): Promise<FastChatOutcome> {
    const outcome: FastChatOutcome = {
      status: "failed",
      answered: [],
      posted: 0,
      needsWork: false,
    };
    try {
      await this.#run(workspace, outcome);
    } catch (error) {
      this.#d.log?.(
        `fast chat ${this.#job.jobId} stopped: ${redactText(String((error as Error)?.message ?? error), 200)}`,
      );
      outcome.status = this.#stopped || this.#abort.signal.aborted ? "cancelled" : "failed";
    }
    if (this.#stopped) outcome.status = "cancelled";
    await this.#write("set_status", {
      status: outcome.status,
      line:
        outcome.status === "completed"
          ? "Answered"
          : outcome.status === "cancelled"
            ? "Stopped by you"
            : "No agent could answer",
    }).catch(() => undefined);
    return outcome;
  }

  async #run(workspace: string, outcome: FastChatOutcome): Promise<void> {
    const contextStart = performance.now();
    const context = await this.#readContext();
    const contextMs = Math.round(performance.now() - contextStart);
    const responders = this.#responders();
    if (!responders.length) return;

    // Who can answer now. A turn never waits on a health probe: the cached
    // state decides, and a run that fails teaches it.
    const peeked = this.#d.health?.peek(responders) ?? {};
    const available: AgentProvider[] = [];
    const exhausted: AgentProvider[] = [];
    for (const p of responders) {
      const h = peeked[p];
      if (!this.#d.runners[p]) continue;
      if (h === "usage_exhausted" || this.#d.isExhausted?.(p)) exhausted.push(p);
      else if (h && UNAVAILABLE.has(h)) continue;
      else available.push(p);
    }
    let answerers = available;
    if (!answerers.length && exhausted.length) {
      const replacement = await this.#replaceExhausted(exhausted[0]!, responders);
      if (replacement === "stop") return;
      answerers = [replacement];
    } else {
      for (const p of exhausted) {
        await sendFailoverNotice(this.#failoverDeps(), {
          from: p,
          to: answerers[0] ?? null,
          reviewPending: false,
          resetsAt: this.#resetsAt(p),
        });
      }
    }
    if (!answerers.length || this.#stopped) return;

    const smallTalk = isSmallTalk(this.#job.goal);
    const firstPrompt = (p: AgentProvider) => this.#firstPrompt(p, context, answerers);
    const firsts = await Promise.all(
      answerers.map((p) =>
        this.#answerWithFailover(p, "first", 0, firstPrompt, null, workspace, contextMs, answerers),
      ),
    );
    const answered: Posted[] = [];
    let workAsked = false;
    for (const r of firsts) {
      if (!r || !r.ok) continue;
      if (r.posted) {
        answered.push(r.posted);
        outcome.posted++;
        if (!outcome.answered.includes(r.posted.provider)) outcome.answered.push(r.posted.provider);
      }
      if (r.answer.needsWork && !workAsked) {
        workAsked = true;
        outcome.needsWork = true;
        await this.#offerWork(r.runId);
      }
    }
    if (this.#stopped) return;
    if (!answered.length) {
      outcome.status = "failed";
      return;
    }
    outcome.status = "completed";

    // Bounded follow-up: only when two or more agents answered and it is not small talk.
    const rounds = Math.max(
      0,
      Math.min(FAST_CHAT_MAX_FOLLOWUPS, this.#d.maxFollowups ?? FAST_CHAT_DEFAULT_FOLLOWUPS),
    );
    const speakers = [...new Set(answered.map((a) => a.provider))];
    for (let round = 1; round <= rounds && speakers.length >= 2 && !smallTalk; round++) {
      if (this.#stopped) return;
      const all = [...answered];
      const replies = await Promise.all(
        speakers.map((provider) => {
          const others = all.filter((m) => m.provider !== provider);
          const replyTo = [...others].reverse().find((m) => m.messageId)?.messageId ?? null;
          return this.#turn(
            provider,
            "followup",
            round,
            () => this.#followupPrompt(provider, all),
            replyTo,
            workspace,
            contextMs,
          );
        }),
      );
      let added = 0;
      for (const r of replies) {
        if (!r.ok || !r.posted) continue;
        added++;
        answered.push(r.posted);
        outcome.posted++;
        if (r.answer.needsWork && !workAsked) {
          workAsked = true;
          outcome.needsWork = true;
          await this.#offerWork(r.runId);
        }
      }
      // Another round only while the agents are still adding something.
      if (!added) break;
    }
  }

  /** The job's responders: named by the server, else the mode's agents. Room members only. */
  #responders(): AgentProvider[] {
    const room = new Set(this.#job.agents.map((a) => a.provider));
    const participants = this.#job.participants?.length
      ? this.#job.participants
      : [...new Set(this.#job.agents.map((a) => a.provider))];
    let list: AgentProvider[];
    if (this.#job.responders?.length) list = this.#job.responders;
    else if (this.#job.mode === "solo") {
      const solo = this.#job.builder ?? this.#job.roleOverrides?.builder ?? participants[0];
      list = solo ? [solo] : [];
    } else list = participants;
    return [...new Set(list)].filter((p) => room.has(p));
  }

  async #readContext(): Promise<ChatContextMessage[]> {
    try {
      const answer = await this.#write(
        OPS_0_11.readChatContext,
        readChatContextPayload(FAST_CHAT_CONTEXT_LIMIT),
      );
      return parseChatContext(answer).slice(-FAST_CHAT_CONTEXT_LIMIT);
    } catch {
      // An older server: the owner's own message is still the question.
      return [];
    }
  }

  #contextText(context: ChatContextMessage[]): string {
    const lines: string[] = [];
    let budget = 24_000;
    for (const m of [...context].reverse()) {
      const who =
        m.authorKind === "agent" && m.authorProviderId
          ? shortName(m.authorProviderId)
          : m.authorKind === "owner"
            ? "Owner"
            : (m.authorLabel ?? (m.authorKind === "threadlink" ? "ThreadLink" : "Someone"));
      // Bodies come from the server already redacted; they stay on this
      // computer (the prompt), so they are only bounded here.
      const line = `${who}: ${m.body.slice(0, 2_000)}`;
      if (budget - line.length < 0) break;
      budget -= line.length;
      lines.unshift(line);
    }
    return lines.join("\n\n");
  }

  #firstPrompt(
    provider: AgentProvider,
    context: ChatContextMessage[],
    answerers: AgentProvider[],
  ): string {
    const others = answerers.filter((p) => p !== provider).map(shortName);
    const history = this.#contextText(context);
    return [
      `You are ${shortName(provider)} (${name(provider)}), one of the agents in a ThreadLink chat ` +
        `for the project "${this.#job.roomName.slice(0, 100)}". The project folder is your ` +
        "working directory.",
      others.length
        ? `${others.join(" and ")} ${others.length > 1 ? "are" : "is"} answering the same message at the same time; you will see ${others.length > 1 ? "their" : "its"} answer afterwards.`
        : "You are the only agent answering this message.",
      "Answer the owner's latest message the way a senior engineer would in a chat: direct, " +
        "concise, conversational. You may read files in the project folder when the question " +
        "needs it. This is a read-only turn: do not change files and do not run commands that " +
        "change anything.",
      "Your `message` is posted in the chat under your name. It is not your private reasoning: " +
        "do not describe your thought process, and never include credentials or secrets.",
      "If answering properly needs real repository work (changing code, running tests or builds), " +
        "do not attempt it: answer what you can and set `needsWork` to true with a one-line " +
        "`workReason`. Otherwise `needsWork` is false and `workReason` is empty.",
      ...this.#workSection(provider),
      INJECTION_RULE,
      ...(history ? [block("RECENT CHAT (oldest first)", history)] : []),
      block("OWNER'S MESSAGE", this.#job.goal.slice(0, 8_000)),
      "Answer with JSON matching the schema.",
    ].join("\n\n");
  }

  /**
   * 0.11.1: when engineering work runs in this same chat, the agent answers as
   * a member of that team, from ThreadLink's status and the agents' messages
   * in the chat -- never as if it were idle, and never with invented progress.
   */
  #workSection(provider: AgentProvider): string[] {
    const chatId = this.#job.chatId;
    if (!chatId || !this.#d.workInChat) return [];
    let work: ChatWorkStatus | null = null;
    try {
      work = this.#d.workInChat(chatId);
    } catch {
      work = null;
    }
    if (!work) return [];
    return [
      "You are also part of the engineering team working on a job in this chat right now (this " +
        "answer runs separately, read-only, beside that job). If the owner asks what you or the " +
        "team are doing, answer as a teammate describing that work, from the status below and " +
        "the agents' messages in the recent chat. Do not say you are idle, only chatting, or not " +
        "working on anything. Do not claim progress, results or test outcomes that are not shown " +
        "there; if something is not known yet, say so.",
      block(
        "WORK IN PROGRESS IN THIS CHAT (ThreadLink's own status)",
        workStatusText(work, provider),
      ),
    ];
  }

  #followupPrompt(provider: AgentProvider, answers: Posted[]): string {
    const mine = answers.filter((a) => a.provider === provider);
    const theirs = answers.filter((a) => a.provider !== provider);
    return [
      `You are ${shortName(provider)} in a ThreadLink chat. You and your teammates just answered ` +
        "the owner's message (shown below).",
      "Reply ONLY if you disagree with a teammate or have something materially new and useful " +
        "to add. Otherwise return an empty `message` -- nothing will be posted, and that is the " +
        "expected outcome most of the time. Do not repeat or summarise what was already said. " +
        "Keep it short. Read-only: do not change files.",
      "Your `message` is posted under your name; it is not your private reasoning.",
      INJECTION_RULE,
      block("OWNER'S MESSAGE", this.#job.goal.slice(0, 8_000)),
      block("YOUR ANSWER", mine.map((m) => m.body).join("\n\n") || "(none)"),
      block(
        "TEAMMATES' ANSWERS",
        theirs.map((m) => `${shortName(m.provider)}: ${m.body}`).join("\n\n"),
      ),
      "Answer with JSON matching the schema.",
    ].join("\n\n");
  }

  #resetsAt(provider: AgentProvider): string | null {
    return this.#lastResets.get(provider) ?? null;
  }
  readonly #lastResets = new Map<AgentProvider, string | null>();

  #failoverDeps(): FailoverDeps {
    return {
      write: (op, payload) => this.#write(op as TeamOp, payload),
      recheck: this.#d.health?.recheck ? (p) => this.#d.health!.recheck!(p) : undefined,
      clock: this.#clock,
      signal: this.#abort.signal,
      choicePollMs: this.#d.choicePollMs,
      choiceWaitMs: this.#d.choiceWaitMs,
      noticesSent: this.#d.noticesSent,
      chatId: this.#job.chatId ?? null,
      log: this.#d.log,
    };
  }

  /**
   * Nobody else is answering and `provider` is out of usage: the job's
   * failover policy decides who answers instead (or whether to wait).
   */
  async #replaceExhausted(
    provider: AgentProvider,
    responders: AgentProvider[],
  ): Promise<AgentProvider | "stop"> {
    const peeked =
      this.#d.health?.peek([...new Set([...responders, ...this.#participants()])]) ?? {};
    const alternatives = this.#participants().filter(
      (p) =>
        p !== provider &&
        this.#d.runners[p] &&
        !this.#d.isExhausted?.(p) &&
        !(peeked[p] && UNAVAILABLE.has(peeked[p]!)),
    );
    const action = await handleExhausted(
      {
        provider,
        resetsAt: this.#resetsAt(provider),
        policy: this.#job.failoverPolicy ?? "auto",
        alternatives,
        params: { step: "chat" },
        key: `${this.#job.jobId}:chat:${provider}`,
      },
      this.#failoverDeps(),
    );
    if (action.action === "other") return action.provider;
    if (action.action === "retry") return provider;
    if (action.action === "stop" && action.why === "owner") this.#stopped = true;
    return "stop";
  }

  #participants(): AgentProvider[] {
    const room = new Set(this.#job.agents.map((a) => a.provider));
    const list = this.#job.participants?.length
      ? this.#job.participants
      : [...new Set(this.#job.agents.map((a) => a.provider))];
    return list.filter((p) => room.has(p));
  }

  /** A first turn; if the agent runs out of usage mid-turn and nobody else answers, fail over. */
  async #answerWithFailover(
    provider: AgentProvider,
    kind: "first",
    round: number,
    prompt: (p: AgentProvider) => string,
    replyTo: string | null,
    workspace: string,
    contextMs: number,
    answerers: AgentProvider[],
  ): Promise<TurnResult | null> {
    const first = await this.#turn(
      provider,
      kind,
      round,
      () => prompt(provider),
      replyTo,
      workspace,
      contextMs,
    );
    if (first.ok || first.failure !== "quota_exhausted" || this.#stopped) return first;
    this.#lastResets.set(provider, first.resetsAt);
    // Others are answering this message: a quiet notice is enough.
    if (answerers.length > 1) {
      await sendFailoverNotice(this.#failoverDeps(), {
        from: provider,
        to: answerers.find((p) => p !== provider) ?? null,
        reviewPending: false,
        resetsAt: first.resetsAt,
      });
      return first;
    }
    const replacement = await this.#replaceExhausted(provider, this.#responders());
    if (replacement === "stop") return first;
    return this.#turn(
      replacement,
      kind,
      round,
      () => prompt(replacement),
      replyTo,
      workspace,
      contextMs,
    );
  }

  /** Asks the owner whether to run this as engineering work (§2.5). Best effort. */
  async #offerWork(runId: string | null): Promise<void> {
    const source = this.#job.sourceEventId;
    if (!source) return;
    try {
      await this.#write(
        OPS_0_10.requestChoice,
        requestChoicePayload(
          "start_work",
          { sourceEventId: source },
          ["run_work", "keep_chatting"],
          `${this.#job.jobId}:start_work`,
          runId,
        ),
      );
    } catch {
      this.#d.log?.("start_work choice was not accepted by the server");
    }
  }

  #runKey(kind: string, round: number, provider: AgentProvider): string {
    const base = `${this.#job.jobId.replace(/^tljob_/, "").slice(0, 12)}:chat:${kind}:r${round}:${provider}`;
    for (let n = 1; ; n++) {
      const key = `${base}:a${n}`;
      if (!this.#runKeys.has(key)) {
        this.#runKeys.add(key);
        return key;
      }
    }
  }

  /**
   * One recorded turn: run_started → the provider → add_message (posted as
   * soon as it returns) → run_finished with timings. A failed resume is
   * retried once with a fresh session.
   */
  async #turn(
    provider: AgentProvider,
    kind: "first" | "followup",
    round: number,
    prompt: () => string,
    replyTo: string | null,
    workspace: string,
    contextMs: number,
    forceFresh = false,
  ): Promise<TurnResult> {
    if (this.#stopped || this.#abort.signal.aborted)
      return { ok: false, failure: "cancelled", resetsAt: null };
    const runner = this.#d.runners[provider];
    if (!runner) return { ok: false, failure: "not_installed", resetsAt: null };
    const route = this.#d.route({
      provider,
      role: CHAT_ROLE,
      // Small talk gets the fast model class; a real question keeps a
      // balanced one (measured: "hi" took ~23 s of model time at medium).
      complexity: isSmallTalk(this.#job.goal) ? "trivial" : "medium",
      risk: NO_RISK,
      previousFailures: 0,
      disputedFindings: 0,
    });
    if (!route.ok) return { ok: false, failure: "no_model", resetsAt: null };
    const caps = (this.#d.capabilities ?? capabilitiesOf)(provider);
    const canResume = Boolean(caps?.nativeSession.resume && caps?.nativeSession.exposed);
    const chatId = this.#job.chatId ?? null;

    // Which native session: this job's (follow-ups), else the chat's stored one.
    let resume: string | null = null;
    let resumedFromRunKey: string | null = null;
    let sessionReason: SessionReason;
    const inJob = this.#jobSessions.get(provider);
    if (forceFresh) sessionReason = "fresh_resume_failed";
    else if (inJob && canResume) {
      resume = inJob.sessionId;
      resumedFromRunKey = inJob.runKey;
      sessionReason = "resumed";
    } else {
      const plan = this.#d.sessions?.plan(chatId, provider, workspace) ?? {
        resume: null,
        reason: "fresh_first_turn" as const,
      };
      if (plan.resume && canResume) {
        resume = plan.resume;
        sessionReason = "resumed";
      } else sessionReason = plan.reason === "resumed" ? "fresh_first_turn" : plan.reason;
    }

    const runKey = this.#runKey(kind, round, provider);
    const participantKey = `${provider}:${CHAT_ROLE}`;
    const timeoutMs = this.#d.timeoutMs ?? FAST_CHAT_TIMEOUT_MS;
    const started = await this.#write(
      OPS_0_10.runStarted,
      runStartedPayload({
        runKey,
        provider,
        participantKey,
        role: CHAT_ROLE,
        requestedModel: route.model,
        effort: route.effort,
        access: "read-only",
        nodeKey: null,
        worktreeLabel: null,
        timeoutMs,
        continuity: resume ? "resumed" : "fresh",
        resumedFromRunKey,
        activity: "responding",
        sessionReason,
      }),
    );
    const runId = parseRunId(started);

    const needsSnapshot = !(
      runner.verifiesAccess || caps?.accessVerification === "provider_reported"
    );
    const snap = this.#d.snapshot ?? gitSnapshot;
    const before = needsSnapshot ? await snap(workspace).catch(() => null) : null;
    const poll =
      (this.#d.controlPollMs ?? CHAT_CONTROL_POLL_MS) > 0
        ? setInterval(() => void this.#pollControl(), this.#d.controlPollMs ?? CHAT_CONTROL_POLL_MS)
        : null;
    let result: AgentRunResult;
    try {
      result = await runner.run({
        provider,
        role: CHAT_ROLE,
        cwd: workspace,
        prompt: prompt(),
        model: route.model,
        effort: route.effort ?? undefined,
        access: "read-only",
        outputSchema: CHAT_SCHEMA,
        resumeThreadId: resume ?? undefined,
        purpose: "chat",
        timeoutMs,
        signal: this.#abort.signal,
        onProcess: this.#d.processes
          ? {
              started: (child) =>
                this.#d.processes!.started(
                  {
                    pid: child.pid!,
                    provider,
                    runId,
                    jobId: this.#job.jobId,
                    startedAt: new Date().toISOString(),
                  },
                  child,
                ),
              exited: (pid) => this.#d.processes!.exited(pid),
            }
          : undefined,
      });
    } catch (error) {
      if (runId) {
        await this.#finishRun(runId, "failed", null, false, false, null, caps, "crashed", {
          queueMs: this.#d.queueMs ?? undefined,
          contextMs,
        }).catch(() => undefined);
      }
      throw error;
    } finally {
      if (poll) clearInterval(poll);
    }

    const t = result.timings;
    const timings: Partial<RunTimings> = {
      ...(this.#d.queueMs != null ? { queueMs: this.#d.queueMs } : {}),
      contextMs,
      ...(t ? { spawnMs: t.spawnMs, providerMs: t.providerMs } : {}),
      ...(t?.firstEventMs != null ? { firstEventMs: t.firstEventMs } : {}),
    };
    const modelVerified = result.modelVerified === true && Boolean(result.observedModel);

    if (!result.ok) {
      const failure = result.failure ?? "provider_error";
      if (runId) {
        await this.#finishRun(
          runId,
          failure === "timeout" ? "timed_out" : failure === "cancelled" ? "cancelled" : "failed",
          result.observedModel,
          modelVerified,
          false,
          result.threadId,
          caps,
          failure === "timeout"
            ? "timeout"
            : failure === "cancelled"
              ? "cancelled"
              : failure === "quota_exhausted" ||
                  failure === "not_authenticated" ||
                  failure === "model_mismatch" ||
                  failure === "access_mismatch"
                ? failure
                : "provider_error",
          timings,
        ).catch(() => undefined);
      }
      if (failure !== "cancelled") {
        try {
          this.#d.health?.noteFailure?.(provider, failure, { resetsAt: result.resetsAt ?? null });
        } catch {
          /* health is advisory */
        }
      }
      if (failure === "quota_exhausted") this.#d.onExhausted?.(provider, result.resetsAt ?? null);
      // A resume that did not work (and not for a reason a fresh session would share): rotate.
      if (resume && !forceFresh && (failure === "provider_error" || failure === "model_mismatch")) {
        this.#jobSessions.delete(provider);
        this.#d.sessions?.forget(chatId, provider, workspace);
        return this.#turn(provider, kind, round, prompt, replyTo, workspace, contextMs, true);
      }
      this.#log(provider, sessionReason, timings, `failed (${failure})`);
      return { ok: false, failure, resetsAt: result.resetsAt ?? null };
    }

    const after = needsSnapshot ? await snap(workspace).catch(() => null) : null;
    const accessVerified = needsSnapshot
      ? before !== null && after !== null && before === after
      : result.accessVerified;
    const answer = readAnswer(result.structured);
    const body = answer ? redactText(answer.message.trim(), CHAT_MESSAGE_MAX) : "";
    // Follow-ups may decline (empty). A first turn that says nothing, or only a
    // placeholder, is not an answer: nothing is posted in its name.
    const declined = !answer || isPlaceholder(body);
    const usable = answer !== null && (kind === "followup" || !declined);

    let posted: Posted | null = null;
    let persistMs = 0;
    if (usable && !declined && runId && !this.#stopped) {
      const t0 = performance.now();
      const answerRow = await this.#write(
        "add_message",
        messagePayload({
          sender: provider,
          senderRole: CHAT_ROLE,
          receiver: null,
          node: null,
          type: "response",
          round,
          body,
          modelObserved: result.observedModel,
          runId,
          replyTo: replyTo ? { kind: "message", id: replyTo } : null,
          refs: [],
        }),
      );
      persistMs = Math.round(performance.now() - t0);
      posted = { provider, messageId: parseMessageId(answerRow), body, runKey };
    }
    if (runId) {
      await this.#finishRun(
        runId,
        usable ? "completed" : "failed",
        result.observedModel,
        modelVerified,
        accessVerified,
        result.threadId,
        caps,
        usable ? null : "provider_error",
        { ...timings, persistMs },
      );
    }
    if (result.threadId && canResume) {
      this.#jobSessions.set(provider, { sessionId: result.threadId, runKey });
      this.#d.sessions?.record(
        chatId,
        provider,
        workspace,
        result.threadId,
        Boolean(resume),
        runKey,
      );
    }
    this.#log(
      provider,
      sessionReason,
      { ...timings, persistMs },
      usable ? (posted ? "posted" : "declined") : "no answer",
    );
    if (!usable) return { ok: false, failure: "no_answer", resetsAt: null };
    return { ok: true, answer: answer!, posted, runId };
  }

  async #finishRun(
    runId: string,
    status: "completed" | "failed" | "cancelled" | "timed_out",
    observedModel: string | null,
    modelVerified: boolean,
    accessVerified: boolean,
    threadId: string | null,
    caps: ProviderCapabilities | null,
    failure: Parameters<typeof runFinishedPayload>[0]["failure"],
    timings: Partial<RunTimings>,
  ): Promise<void> {
    await this.#write(
      OPS_0_10.runFinished,
      runFinishedPayload({
        runId,
        status,
        observedModel,
        modelVerified,
        accessVerified,
        nativeSessionId: caps?.nativeSession.exposed ? threadId : null,
        nativeSessionKind: caps?.nativeSession.kind ?? null,
        failure,
        exitClean: status === "completed",
        timings,
      }),
    );
  }

  /** One local latency line per turn. Never prompt or answer text. */
  #log(
    provider: AgentProvider,
    reason: SessionReason,
    t: Partial<RunTimings>,
    outcome: string,
  ): void {
    const f = (v: number | undefined) => (v === undefined ? "-" : `${v}ms`);
    this.#d.log?.(
      `fast-chat ${this.#job.jobId.slice(0, 18)} ${provider}: ${outcome}; session=${reason} ` +
        `queue=${f(t.queueMs)} context=${f(t.contextMs)} spawn=${f(t.spawnMs)} ` +
        `first=${f(t.firstEventMs)} provider=${f(t.providerMs)} persist=${f(t.persistMs)}`,
    );
  }

  async #pollControl(): Promise<void> {
    if (this.#choicesUnavailable || this.#stopped) return;
    const now = this.#clock.now();
    if (now - this.#lastControlPoll < (this.#d.controlPollMs ?? CHAT_CONTROL_POLL_MS) / 2) return;
    this.#lastControlPoll = now;
    try {
      await this.#write(OPS_0_10.readChoices, readChoicesPayload([]));
    } catch {
      this.#choicesUnavailable = true;
    }
  }

  async #write(op: TeamOp, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const answer = (await this.#d.sink(op, payload)) ?? {};
    const control = parseControl(answer);
    // Stop (now or "after this"): a chat turn has nothing to finish first.
    if (control && (control.control === "stop_now" || control.control === "cancel_queued")) {
      if (!this.#stopped) {
        this.#stopped = true;
        this.#abort.abort();
        void this.#d.processes?.killJob(this.#job.jobId).catch(() => 0);
      }
    }
    return answer;
  }
}

function readAnswer(structured: unknown): ChatAnswer | null {
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) return null;
  const s = structured as Record<string, unknown>;
  if (typeof s.message !== "string") return null;
  return {
    message: s.message,
    needsWork: s.needsWork === true,
    workReason: typeof s.workReason === "string" ? redactText(s.workReason, 300) : "",
  };
}
