import fs from "node:fs/promises";
import { eq } from "drizzle-orm";
import { activityLog, heartbeatRuns, type Db } from "@paperclipai/db";
import { reservePersistentControlPlaneWrite, readControlPlaneIntents } from "@paperclipai/adapter-utils/control-plane-intents";
import { HttpError } from "../errors.js";
import { classifyControlPlaneFailure } from "./control-plane-failures.js";
import { settleControlPlaneWrite, type WriteIdentity } from "./control-plane-write-budget.js";

export async function withControlPlaneStorage<T>(identity: WriteIdentity, work: () => Promise<T>, reservationId?: string): Promise<T> {
  const ticket = await reservePersistentControlPlaneWrite(identity.runId, "storage", undefined, reservationId).catch((error: unknown) => {
    const exhausted = error instanceof Error && error.message === "control_plane_write_budget_exhausted";
    throw new HttpError(exhausted ? 409 : 503, "Control-plane storage containment is active", { code: exhausted ? "control_plane_write_budget_exhausted" : "control_plane_intent_storage_unavailable", retryable: false });
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([work(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("control_plane_storage_timeout")), 5000);
    })]);
    await ticket.succeed();
    return result;
  } catch (error) {
    if (error instanceof HttpError || (error instanceof Error && error.message === "paperclip_runner_tool_binding_not_authorized")) await ticket.succeed();
    else await ticket.fail();
    throw error instanceof HttpError || (error instanceof Error && error.message === "paperclip_runner_tool_binding_not_authorized") ? error : new HttpError(503, "Control-plane storage unavailable", { code: "control_plane_storage_unavailable" });
  } finally { if (timer) clearTimeout(timer); }
}

/** Reconcile reporting intents only. Resolve company/agent from the persisted
 * run, never from filesystem or caller claims. Settlement is idempotent. */
export async function reconcileControlPlaneOutages(db: Db, directory?: string) {
  for (const { filename, intent } of await readControlPlaneIntents(directory)) {
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, intent.runId));
    if (!run) continue;
    const reservationId = intent.reservationId ?? intent.id;
    if (!intent.reservationId) await db.insert(activityLog).values({ id: reservationId, companyId: run.companyId,
      agentId: run.agentId, runId: run.id, actorType: "system", actorId: "control_plane_failure_guard",
      action: "control_plane.write_reserved", entityType: "control_plane_operation", entityId: "offline-incident-intent",
    }).onConflictDoNothing();
    await settleControlPlaneWrite(db, { companyId: run.companyId, agentId: run.agentId, runId: run.id, reservationId,
      failure: classifyControlPlaneFailure(intent.kind === "storage" ? { code: "CONNECTION_CLOSED" } : intent.status ? { status: intent.status } : { code: "api_transport_failure" }),
    });
    // Never reset an active heartbeat's budget. Terminal runs cannot dispatch;
    // prune only after their incident settlement has committed.
    if (run.finishedAt || ["succeeded", "failed", "cancelled", "timed_out"].includes(run.status)) {
      await fs.unlink(`${filename}.failed`).catch(() => undefined);
      await fs.unlink(filename).catch(() => undefined);
    }
  }
}
