/**
 * First run (brief §62–63): "Welcome to ThreadLink — connect your coding
 * agents → create your first chat". Pure: the steps and their state from
 * facts the page already loaded. Health counts only when freshly checked.
 */

export type OnboardingStep = {
  key: "agents" | "chat";
  title: string;
  detail: string;
  state: "done" | "current" | "todo";
  href: string;
  cta: string;
};

export type Onboarding = { show: boolean; title: string; intro: string; steps: OnboardingStep[] };

export function onboarding(facts: {
  chats: number;
  /** Agents whose last real check says Ready and is fresh. */
  readyAgents: string[];
  /** Agents that were detected at all (installed or checked). */
  detectedAgents: number;
}): Onboarding {
  const agentsDone = facts.readyAgents.length > 0;
  const chatDone = facts.chats > 0;
  return {
    show: !chatDone,
    title: "Welcome to ThreadLink",
    intro:
      "ThreadLink runs your coding agents together in one chat: one project, one AI team, every result attributed. Two steps to start.",
    steps: [
      {
        key: "agents",
        title: "Connect your coding agents",
        detail: agentsDone
          ? `${facts.readyAgents.join(" and ")} ${facts.readyAgents.length === 1 ? "is" : "are"} ready on your computer.`
          : facts.detectedAgents > 0
            ? "ThreadLink found your agents but they are not ready yet. Open Agents to see what each one needs."
            : "Install the ThreadLink app on the computer where you code, then sign in to Claude Code and/or Codex there.",
        state: agentsDone ? "done" : "current",
        href: "/dashboard/agents",
        cta: agentsDone ? "Review agents" : "Set up agents",
      },
      {
        key: "chat",
        title: "Create your first chat",
        detail:
          "Pick the project folder the agents should work in and how they work: Solo, Builder + Reviewer, or the whole Team.",
        state: chatDone ? "done" : agentsDone ? "current" : "todo",
        href: "/dashboard/chats#new-chat",
        cta: "New chat",
      },
    ],
  };
}
