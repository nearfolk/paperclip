import { enqueueIncidentNotification } from "./control-plane-incident-outbox.js";
import { and, eq, inArray, sql } from "drizzle-orm";
import { activityLog, agents, companies, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import { conflict } from "../errors.js";
import { invalidRunContext } from "./validated-run-context.js";
import type { FailureClassification } from "./control-plane-failures.js";

const RESERVED = "control_plane.write_reserved";
const FAILED = "control_plane.write_failed";
const SUCCEEDED = "control_plane.write_succeeded";
export type WriteIdentity = { companyId: string; agentId: string; runId: string };

/** Reservations survive process loss and count conservatively as failures.
 * At most two attempts may execute concurrently, even across server replicas.
 */
export async function reserveControlPlaneWrite(db: Db, input: WriteIdentity & { fingerprint: string }) {
  if (!isUuidLike(input.runId)) throw invalidRunContext();
  return db.transaction(async (tx) => {
    const [run] = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, input.agentId),
    )).for("update");
    if (!run || run.status !== "running" || run.finishedAt) throw invalidRunContext();
    const prior = await tx.select({ id: activityLog.id }).from(activityLog).where(and(
      eq(activityLog.companyId, input.companyId), eq(activityLog.runId, input.runId),
      eq(activityLog.entityId, input.fingerprint), inArray(activityLog.action, [RESERVED, FAILED]),
    ));
    if (prior.length >= 2) throw conflict("Write failure budget exhausted for this heartbeat", { code: "control_plane_write_budget_exhausted", retryable: false });
    const [reservation] = await tx.insert(activityLog).values({
      ...input, actorType: "agent", actorId: input.agentId,
      action: RESERVED, entityType: "control_plane_operation", entityId: input.fingerprint,
    }).returning({ id: activityLog.id });
    return reservation!.id;
  });
}

/** Idempotent settlement. Incident and occurrence are committed together. */
export async function settleControlPlaneWrite(db: Db, input: WriteIdentity & { reservationId: string; failure?: FailureClassification }) {
  if (!input.failure) {
    await db.update(activityLog).set({ action: SUCCEEDED }).where(and(eq(activityLog.id, input.reservationId),
      eq(activityLog.companyId, input.companyId), eq(activityLog.agentId, input.agentId),
      eq(activityLog.runId, input.runId), eq(activityLog.action, RESERVED)));
    return null;
  }
  return db.transaction(async (tx) => {
    // One company lock makes root-cause upsert deterministic across reporters.
    const [company] = await tx.select().from(companies).where(eq(companies.id, input.companyId)).for("update");
    if (!company) throw invalidRunContext();
    const [settled] = await tx.update(activityLog).set({
      action: input.failure ? FAILED : SUCCEEDED,
      details: input.failure ? { ...input.failure } : null,
    }).where(and(eq(activityLog.id, input.reservationId), eq(activityLog.companyId, input.companyId),
      eq(activityLog.agentId, input.agentId), eq(activityLog.runId, input.runId), eq(activityLog.action, RESERVED))).returning();
    if (!settled || !input.failure) return null;
    const failure = input.failure;
    const root = `${failure.category}:${failure.rootCause}`;
    const [existing] = await tx.select().from(issues).where(and(eq(issues.companyId, input.companyId),
      eq(issues.originKind, "control_plane_incident"), eq(issues.originId, root)));
    if (existing) {
      const [summary] = await tx.select().from(activityLog).where(and(eq(activityLog.companyId, input.companyId),
        eq(activityLog.action, "control_plane.incident_summary"), eq(activityLog.entityId, existing.id)));
      const prior = typeof summary?.details?.occurrences === "number" ? summary.details.occurrences : 1;
      const details = { ...failure, occurrences: prior + 1, lastObservedAt: new Date().toISOString() };
      if (summary) await tx.update(activityLog).set({ details }).where(eq(activityLog.id, summary.id));
      else await tx.insert(activityLog).values({ companyId: input.companyId, actorType: "system", actorId: "control_plane_failure_guard", action: "control_plane.incident_summary", entityType: "issue", entityId: existing.id, details });
      await tx.update(issues).set({
        // Reuse the same incident on recurrence, including after resolution.
        ...(existing.status === "done" || existing.status === "cancelled" ? { status: "todo", completedAt: null, cancelledAt: null } : {}),
        updatedAt: new Date(),
      }).where(eq(issues.id, existing.id));
      if (existing.status === "done" || existing.status === "cancelled") {
        await enqueueIncidentNotification(tx, input.companyId, { issueId: existing.id, ownerAgentId: existing.assigneeAgentId });
      }
      return { issueId: existing.id, ownerAgentId: existing.assigneeAgentId, created: false };
    }
    const [owner] = await tx.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, input.companyId), eq(agents.role, "cto"), inArray(agents.status, ["active", "idle", "running", "error"]))).limit(1);
    const [counter] = await tx.update(companies).set({ issueCounter: sql`${companies.issueCounter} + 1` }).where(eq(companies.id, input.companyId)).returning({ value: companies.issueCounter });
    const [incident] = await tx.insert(issues).values({
      companyId: input.companyId, title: `Control-plane ${failure.category}: ${failure.rootCause}`,
      description: `Unblock owner: ${failure.owner}. Investigate ${failure.rootCause}. Retryable: ${failure.retryable}. Do not bypass authorization or replay an ambiguous write. Occurrence counts are in the control_plane.incident_summary activity record; no request bodies or credentials are retained.`,
      status: "todo", priority: "high", assigneeAgentId: owner?.id ?? (company.defaultResponsibleUserId ? null : input.agentId),
      assigneeUserId: owner ? null : company.defaultResponsibleUserId,
      responsibleUserId: company.defaultResponsibleUserId,
      originKind: "control_plane_incident", originId: root, originFingerprint: root,
      issueNumber: counter!.value, identifier: `${company.issuePrefix}-${counter!.value}`,
    }).returning({ id: issues.id });
    await tx.insert(activityLog).values({ companyId: input.companyId, actorType: "system", actorId: "control_plane_failure_guard", action: "control_plane.incident_summary", entityType: "issue", entityId: incident!.id, details: { occurrences: 1, ...failure, lastObservedAt: new Date().toISOString() } });
    await tx.insert(activityLog).values({ companyId: input.companyId, actorType: "system", actorId: "control_plane_failure_guard", action: "issue.created", entityType: "issue", entityId: incident!.id, details: { originKind: "control_plane_incident", rootCause: failure.rootCause } });
    await enqueueIncidentNotification(tx, input.companyId, { issueId: incident!.id, ownerAgentId: owner?.id ?? (company.defaultResponsibleUserId ? null : input.agentId) });
    return { issueId: incident!.id, ownerAgentId: owner?.id ?? (company.defaultResponsibleUserId ? null : input.agentId), created: true };
  });
}
