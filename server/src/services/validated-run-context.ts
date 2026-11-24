import { and, eq } from "drizzle-orm";
import { heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import { forbidden } from "../errors.js";

export function invalidRunContext() {
  return forbidden("An active run bound to this agent, company and source issue is required", {
    code: "cross_issue_influence_run_context_required",
    remediation: "Resume the assigned source issue with a fresh run; do not retry this write in the current heartbeat.",
  });
}

/** Persisted references only. A header selects a run; it never grants scope. */
export function runSourceReferences(run: { contextSnapshot?: unknown; nativeIssueId?: string | null }) {
  const context = run.contextSnapshot && typeof run.contextSnapshot === "object" && !Array.isArray(run.contextSnapshot)
    ? run.contextSnapshot as Record<string, unknown> : {};
  const values = [context.issueId, context.taskId, run.nativeIssueId].filter((v) => v !== undefined && v !== null);
  if (values.some((v) => typeof v !== "string" || !v.trim())) throw invalidRunContext();
  const references = [...new Set((values as string[]).map((v) => v.trim()))];
  if (!references.length) throw invalidRunContext();
  return references;
}

export async function resolveRunSourceIssue(db: Pick<Db, "select">, companyId: string, run: Parameters<typeof runSourceReferences>[0]) {
  const references = runSourceReferences(run);
  let source: { id: string; executionRunId: string | null } | undefined;
  for (const reference of references) {
    const [issue] = await db.select({ id: issues.id, executionRunId: issues.executionRunId }).from(issues).where(and(
      eq(issues.companyId, companyId),
      isUuidLike(reference) ? eq(issues.id, reference) : eq(issues.identifier, reference.toUpperCase()),
    ));
    if (!issue || (source && source.id !== issue.id)) throw invalidRunContext();
    source = issue;
  }
  return source!;
}

export async function validateAgentWriteRun(db: Pick<Db, "select">, input: { companyId: string; agentId: string; runId?: string }) {
  if (!input.runId || !isUuidLike(input.runId)) throw invalidRunContext();
  const [run] = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, input.agentId),
  ));
  if (!run || run.companyId !== input.companyId || run.agentId !== input.agentId || run.status !== "running" || run.finishedAt) throw invalidRunContext();
  const source = await resolveRunSourceIssue(db, input.companyId, run);
  if (source.executionRunId && source.executionRunId !== run.id) throw invalidRunContext();
  return { run, source };
}
