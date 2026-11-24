/** Local run evidence. This contract does not confer incident or execution authority. */
export type HeartbeatProgressOutcome = "skipped_preflight" | "no_op" | "delivered_progress" | "worked" | "failed" | "unknown";

export interface HeartbeatProgressSummary {
  version: 1;
  consecutiveNoOps: number;
  timersSuppressed: boolean;
  modelRuns: number;
  skippedPreflight: number;
  noOpRuns: number;
  successfulTurns: number;
  uniqueTaskCompletions: number;
  blockerResolutions: number;
  inputTokens: number;
  outputTokens: number;
  measuredCostUsd: number;
  unknownCostRuns: number;
}
