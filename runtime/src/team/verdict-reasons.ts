/**
 * Verdict reason codes, mirrored by team_jobs_verdict_reason_check and
 * threadlink_private.chat_reason_text in the collaboration-chat migration.
 */
/** Why a job ended as it did. The chat shows a fixed sentence per code. */
export const VERDICT_REASONS = [
  "tests_failed",
  "review_not_passed",
  "agents_disagree",
  "dependency_not_finished",
  "plan_blocked",
  "agent_unavailable",
  "agent_not_in_project",
  "usage_exhausted",
  "model_mismatch",
  "access_mismatch",
  "agent_timed_out",
  "agent_failed",
  "changed_during_review",
  "inspection_found_issues",
  "no_review_or_tests",
  "stopped_by_owner",
  "unexpected_error",
  "merge_conflict",
  "no_suitable_model",
] as const;
export type VerdictReason = (typeof VERDICT_REASONS)[number];
