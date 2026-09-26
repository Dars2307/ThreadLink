import { updateProjectPolicyAction } from "@/app/dashboard/team-actions";
import { ActionForm, SubmitButton } from "@/components/dashboard/action-form";
import { buttonStyles } from "@/components/ui";
import type { ProjectCard, ProjectsView } from "@/lib/dashboard/pages";

const field = "border-border-strong bg-surface rounded-lg border px-3 py-2 text-sm";

function range(min: number, max: number): number[] {
  return Array.from({ length: max - min + 1 }, (_, i) => min + i);
}

/** A project's team settings: agents at once, usage policy, planning and review rounds. */
export function ProjectPolicyForm({
  roomId,
  policy,
  limits,
  usagePolicies,
}: {
  roomId: string;
  policy: ProjectCard["policy"];
  limits: ProjectsView["limits"];
  usagePolicies: ProjectsView["usagePolicies"];
}) {
  return (
    <ActionForm
      action={updateProjectPolicyAction}
      className="bg-surface-muted mt-3 grid gap-3 rounded-xl p-4 sm:grid-cols-2"
      statusClassName="sm:col-span-2"
    >
      <input type="hidden" name="roomId" value={roomId} />
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-subtle text-xs">Agents working at once</span>
        <select
          key={String(policy.parallelAgents)}
          name="parallelAgents"
          defaultValue={policy.parallelAgents}
          className={field}
        >
          {range(limits.parallelAgents.min, limits.parallelAgents.max).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-subtle text-xs">Usage policy</span>
        <select
          key={String(policy.usagePolicy)}
          name="usagePolicy"
          defaultValue={policy.usagePolicy}
          className={field}
        >
          {usagePolicies.map((u) => (
            <option key={u.value} value={u.value}>
              {u.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-subtle text-xs">Planning rounds (at most)</span>
        <select
          key={String(policy.maxPlanningRounds)}
          name="maxPlanningRounds"
          defaultValue={policy.maxPlanningRounds}
          className={field}
        >
          {range(limits.planningRounds.min, limits.planningRounds.max).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-subtle text-xs">Review rounds (at most)</span>
        <select
          key={String(policy.maxReviewRounds)}
          name="maxReviewRounds"
          defaultValue={policy.maxReviewRounds}
          className={field}
        >
          {range(limits.reviewRounds.min, limits.reviewRounds.max).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <p className="text-subtle text-xs sm:col-span-2">
        Applies to new team work in this project. When the rounds run out, the team stops and asks
        you rather than passing work that is not ready.
      </p>
      <SubmitButton className={`${buttonStyles.secondary} w-fit`}>Save team settings</SubmitButton>
    </ActionForm>
  );
}
