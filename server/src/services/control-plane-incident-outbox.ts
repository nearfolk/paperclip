import { randomUUID } from "node:crypto";
import { and, eq, ne, sql } from "drizzle-orm";
import { activityLog, agentWakeupRequests, type Db } from "@paperclipai/db";

export type IncidentNotification = { issueId: string; ownerAgentId: string | null; idempotencyKey: string };
const PENDING = "control_plane.notification_pending";
const DELIVERED = "control_plane.notification_delivered";
const MAX_ATTEMPTS = 8;

/** Called inside the incident transaction, including every closed->open recurrence. */
export async function enqueueIncidentNotification(tx: Pick<Db, "insert">, companyId: string, incident: Omit<IncidentNotification, "idempotencyKey">) {
  const id = randomUUID();
  await tx.insert(activityLog).values({ id, companyId, actorType: "system", actorId: "control_plane_failure_guard",
    action: PENDING, entityType: "issue", entityId: incident.issueId,
    details: { ...incident, idempotencyKey: `control-plane-incident:v2:${id}`, attempts: 0, nextAttemptAt: 0 },
  });
}

/** Leases survive process loss. The receiver's unique key is the final arbiter
 * if a delivery commits but its acknowledgement is lost. No raw errors persist. */
export async function reconcileIncidentNotifications(db: Db, notify: (incident: IncidentNotification) => Promise<unknown>, options: { now?: number; timeoutMs?: number; limit?: number; companyId?: string } = {}) {
  const now = options.now ?? Date.now();
  for (let i = 0; i < (options.limit ?? 20); i++) {
    const claim = await db.transaction(async (tx) => {
      const [row] = await tx.select().from(activityLog).where(and(eq(activityLog.action, PENDING),
        sql`coalesce((${activityLog.details}->>'nextAttemptAt')::bigint, 0) <= ${now}`,
        options.companyId ? eq(activityLog.companyId, options.companyId) : undefined,
      )).limit(1).for("update", { skipLocked: true });
      if (!row) return null;
      const details = row.details!;
      const attempts = Math.min(MAX_ATTEMPTS, Number(details.attempts) + 1);
      await tx.update(activityLog).set({ details: { ...details, attempts, nextAttemptAt: now + Math.min(300_000, 1000 * 2 ** attempts) + 30_000 } }).where(eq(activityLog.id, row.id));
      return { ...row, details, attempts };
    });
    if (!claim) return;
    const notification = claim.details as unknown as IncidentNotification;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const [receipt] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, claim.companyId), eq(agentWakeupRequests.idempotencyKey, notification.idempotencyKey), ne(agentWakeupRequests.status, "skipped"),
      )).limit(1);
      if (!receipt && notification.ownerAgentId) {
        if (Number(claim.details.attempts) >= MAX_ATTEMPTS) continue;
        await Promise.race([notify(notification), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("notification_timeout")), options.timeoutMs ?? 5000);
        })]);
        // A callback return alone is not durable delivery evidence.
        const [saved] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
          eq(agentWakeupRequests.companyId, claim.companyId), eq(agentWakeupRequests.idempotencyKey, notification.idempotencyKey), ne(agentWakeupRequests.status, "skipped"),
        )).limit(1);
        if (!saved) continue;
      }
      await db.update(activityLog).set({ action: DELIVERED }).where(eq(activityLog.id, claim.id));
    } catch {
      // Lease/backoff is already committed. Exhaustion retains an inspectable intent.
    } finally { if (timer) clearTimeout(timer); }
  }
}
