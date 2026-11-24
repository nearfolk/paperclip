import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  type Db, agents, issues, issueComments, heartbeatRuns, agentWakeupRequests,
  activityLog, heartbeatProgressState, heartbeatProgressReceipts,
  heartbeatProgressOutcomes, heartbeatDeliveredTransitions,
} from "@paperclipai/db";
import type { HeartbeatProgressSummary } from "@paperclipai/shared";
import { buildIssueBlockersResolvedWakeStateKey } from "./issue-dependency-wakeups.js";

// No prose, history, instructions, provider calls or wall-clock cooldown in this gate.
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

type Agent = typeof agents.$inferSelect;
type Run = typeof heartbeatRuns.$inferSelect;
type Client = Pick<Db, "select">;
export interface ProgressDependencies {
  readiness(companyId: string, ids: string[], client: Client): Promise<Map<string, { isDependencyReady: boolean; unresolvedBlockerIssueIds: string[]; blockerIssueIds: string[] }>>;
  held(companyId: string, issueId: string): Promise<unknown>;
  invocationBlock(agent: Agent, issueId: string | null): Promise<string | null>;
}
export interface ProgressWake {
  source: string;
  issueId?: string | null;
  commentId?: string | null;
  actorType?: string | null;
  eventId?: string | null;
}

/** Explicit advisory metadata, acknowledgements and self reminders never create work. */
export function relevantCommentKey(comment: {
  body: string; authorAgentId: string | null; authorUserId: string | null;
  deletedAt: Date | null; metadata: unknown;
}, agentId: string, issueId: string): string | null {
  const metadata = object(comment.metadata);
  const body = comment.body.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
  if (comment.deletedAt || comment.authorAgentId === agentId || !body ||
      metadata.wakeRelevance === "none" || metadata.wakeRelevance === "reminder" ||
      /^(thanks[!.]?|thank you[!.]?|ack[!.]?|acknowledged[!.]?|fyi[:.!]?|ping[!.]?|reminder[!.]?)$/.test(body)) return null;
  // Agent prose is not evidence. An explicit action request from another seat is
  // eligible; state transitions remain eligible independently of comment text.
  if ((comment.authorAgentId || !comment.authorUserId) && metadata.wakeRelevance !== "action_required") return null;
  return `comment:${issueId}:${digest([comment.authorAgentId ?? comment.authorUserId, body])}`;
}

export function heartbeatProgressService(db: Db, deps: ProgressDependencies) {
  async function snapshot(agent: Agent, wake: ProgressWake, client: Client = db) {
    const candidates = await client.select({
      id: issues.id, status: issues.status, assigneeAgentId: issues.assigneeAgentId,
      assigneeUserId: issues.assigneeUserId, executionState: issues.executionState, blockedTransitionAt: issues.blockedTransitionAt,
      contentHash: sql<string>`md5(coalesce(${issues.title}, '') || coalesce(${issues.description}, ''))`,
    }).from(issues).where(and(
      eq(issues.companyId, agent.companyId), isNull(issues.hiddenAt),
      wake.issueId
        ? sql`(${issues.id}::text = ${wake.issueId} or ${issues.identifier} = ${wake.issueId})`
        : and(inArray(issues.status, ["todo", "in_progress", "in_review", "blocked"]), or(
          eq(issues.assigneeAgentId, agent.id),
          sql`${issues.executionState}->'currentParticipant'->>'agentId' = ${agent.id}`,
        )),
    ));
    const readiness = await deps.readiness(agent.companyId, candidates.map(i => i.id), client);
    const rows = await Promise.all(candidates.map(async issue => {
      const participant = object(object(issue.executionState).currentParticipant);
      const owns = issue.status === "in_review" && Object.keys(participant).length > 0
        ? participant.type === "agent" && participant.agentId === agent.id
        : issue.assigneeAgentId === agent.id && !issue.assigneeUserId;
      const ready = readiness.get(issue.id)?.isDependencyReady ?? true;
      const held = Boolean(await deps.held(agent.companyId, issue.id));
      return { ...issue, owns, ready, held, actionable: owns && ready && !held &&
        ["todo", "in_progress", "in_review"].includes(issue.status),
        blockerIds: readiness.get(issue.id)?.blockerIssueIds.slice().sort() ?? [],
        blockers: readiness.get(issue.id)?.unresolvedBlockerIssueIds.slice().sort() ?? [] };
    }));
    const fingerprint = digest(rows.map(i => [i.id, i.status === "todo" ? "in_progress" : i.status,
      i.owns, i.ready, i.held, i.blockers, i.contentHash, i.executionState]).sort((a,b) => String(a[0]).localeCompare(String(b[0]))));
    return { rows, fingerprint, actionable: rows.some(i => i.actionable) };
  }

  async function lockState(client: Db, agent: Agent) {
    await client.insert(heartbeatProgressState).values({ companyId: agent.companyId, agentId: agent.id }).onConflictDoNothing();
    return client.select().from(heartbeatProgressState).where(and(
      eq(heartbeatProgressState.companyId, agent.companyId), eq(heartbeatProgressState.agentId, agent.id),
    )).for("update").then(rows => rows[0]!);
  }

  async function evaluate(agent: Agent, wake: ProgressWake, runId?: string, consume = false) {
    const fresh = await db.select().from(agents).where(and(eq(agents.id, agent.id), eq(agents.companyId, agent.companyId))).then(rows => rows[0]);
    if (!fresh) return { allowed: false, reason: "agent_missing" };
    const block = await deps.invocationBlock(fresh, wake.issueId ?? null);
    if (block) return { allowed: false, reason: block };
    // Do not hold a state lock while calling services that use another pool slot.
    const current = await snapshot(fresh, wake);
    return db.transaction(async tx => {
      const state = await lockState(tx as unknown as Db, agent);
      if (runId) {
        const boundRun = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
          eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, agent.companyId), eq(heartbeatRuns.agentId, agent.id),
        )).then(rows => rows[0]);
        if (!boundRun) return { allowed: false, reason: "run_binding_invalid" };
      }
      const scoped = wake.issueId ? current.rows[0] : null;
      if (wake.issueId && !scoped) return { allowed: false, reason: "issue_missing" };
      if (scoped && !scoped.ready) return { allowed: false, reason: "issue_dependencies_blocked" };
      if (scoped?.held) return { allowed: false, reason: "issue_tree_hold_active" };
      if (scoped && !scoped.owns) return { allowed: false, reason: "issue_owner_changed" };

      let eventKey: string | null = null;
      if (wake.commentId && scoped) {
        const comment = await tx.select({ body: issueComments.body, authorAgentId: issueComments.authorAgentId,
          authorUserId: issueComments.authorUserId, deletedAt: issueComments.deletedAt, metadata: issueComments.metadata,
        }).from(issueComments).where(and(eq(issueComments.companyId, agent.companyId),
          eq(issueComments.issueId, scoped.id), eq(issueComments.id, wake.commentId))).then(rows => rows[0]);
        eventKey = comment ? relevantCommentKey(comment, agent.id, scoped.id) : null;
        if (!eventKey) return { allowed: false, reason: "irrelevant_comment" };
      } else if (wake.source !== "timer" && wake.actorType === "user" && wake.eventId) {
        // Event identity comes from a persisted wake request, not a supplied reason.
        eventKey = `manual:${wake.eventId}`;
      }
      if (!eventKey && scoped?.status === "blocked" && scoped.ready && scoped.blockerIds.length > 0) {
        // The route may enqueue before writing its activity receipt. Derive the
        // exact existing dependency-ready identity from persisted edges/cycle.
        const key = buildIssueBlockersResolvedWakeStateKey({ dependentIssueId: scoped.id,
          blockerIssueIds: scoped.blockerIds, blockedTransitionAt: scoped.blockedTransitionAt });
        const consumed = await tx.select({ runId: heartbeatProgressReceipts.runId }).from(heartbeatProgressReceipts)
          .where(and(eq(heartbeatProgressReceipts.companyId, agent.companyId), eq(heartbeatProgressReceipts.agentId, agent.id), eq(heartbeatProgressReceipts.eventKey, key)))
          .then(rows => rows[0]);
        if (!consumed || consumed.runId === runId) eventKey = key;
      }
      if (!eventKey && scoped) {
        // Only persisted external business-field changes or resolved interactions
        // qualify. Status polling, timestamps, logs and self-authored updates do not.
        const delta = await tx.select({ id: activityLog.id }).from(activityLog).where(and(
          eq(activityLog.companyId, agent.companyId), eq(activityLog.entityType, "issue"),
          eq(activityLog.entityId, scoped.id), sql`${activityLog.actorId} <> ${agent.id}`,
          or(
            and(eq(activityLog.action, "issue.updated"),
              sql`coalesce(${activityLog.details}->'changes', '{}'::jsonb) ?| array['title','description','assigneeAgentId','executionPolicy','executionState','workMode']`),
            inArray(activityLog.action, ["issue.thread_interaction_accepted", "issue.thread_interaction_answered", "issue.blockers_updated"]),
          ),
        )).orderBy(desc(activityLog.createdAt), desc(activityLog.id)).limit(1).then(rows => rows[0]);
        if (delta) {
          const key = `activity:${delta.id}`;
          const consumed = await tx.select({ runId: heartbeatProgressReceipts.runId }).from(heartbeatProgressReceipts)
            .where(and(eq(heartbeatProgressReceipts.companyId, agent.companyId), eq(heartbeatProgressReceipts.agentId, agent.id), eq(heartbeatProgressReceipts.eventKey, key)))
            .then(rows => rows[0]);
          if (!consumed || consumed.runId === runId) eventKey = key;
        }
      }
      const receipt = eventKey ? await tx.select().from(heartbeatProgressReceipts).where(and(
        eq(heartbeatProgressReceipts.companyId, agent.companyId), eq(heartbeatProgressReceipts.agentId, agent.id),
        eq(heartbeatProgressReceipts.eventKey, eventKey),
      )).then(rows => rows[0]) : null;
      if (receipt && receipt.runId !== runId) return { allowed: false, reason: "duplicate_context" };
      const relevantDelta = !!eventKey;
      if (!current.actionable && !relevantDelta) return { allowed: false,
        reason: state.timersSuppressed ? "timers_suppressed" : "no_actionable_work" };
      // Unscoped manual invocations cannot route around a blocked assignment.
      if (!scoped && !current.actionable && current.rows.some(i => !i.ready || i.held))
        return { allowed: false, reason: "issue_dependencies_blocked" };
      const existingRun = runId ? await tx.select().from(heartbeatProgressOutcomes)
        .where(eq(heartbeatProgressOutcomes.runId, runId)).then(rows => rows[0]) : null;
      if (consume && runId && !existingRun) {
        const reset = current.actionable && current.fingerprint !== state.fingerprint || relevantDelta && !receipt;
        const generation = state.generation + (reset ? 1 : 0);
        await tx.update(heartbeatProgressState).set({ fingerprint: current.fingerprint, generation,
          ...(reset ? { consecutiveNoOps: 0, timersSuppressed: false } : {}), updatedAt: new Date(),
        }).where(eq(heartbeatProgressState.agentId, agent.id));
        if (eventKey && !receipt) await tx.insert(heartbeatProgressReceipts).values({
          companyId: agent.companyId, agentId: agent.id, eventKey, runId,
        }).onConflictDoNothing();
        await tx.insert(heartbeatProgressOutcomes).values({ companyId: agent.companyId, agentId: agent.id,
          runId, generation, outcome: "unknown", reason: relevantDelta ? "relevant_context" : "actionable_assignment",
        }).onConflictDoNothing();
      }
      return { allowed: true, reason: relevantDelta ? "relevant_context" : "actionable_assignment" };
    });
  }

  async function wakeForRun(run: Run): Promise<ProgressWake> {
    const context = object(run.contextSnapshot);
    const request = run.wakeupRequestId ? await db.select().from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.id, run.wakeupRequestId), eq(agentWakeupRequests.companyId, run.companyId)))
      .then(rows => rows[0]) : null;
    return { source: run.invocationSource, issueId: typeof context.issueId === "string" ? context.issueId : null,
      commentId: typeof context.wakeCommentId === "string" ? context.wakeCommentId :
        typeof context.commentId === "string" ? context.commentId : null,
      actorType: request?.requestedByActorType, eventId: request?.id };
  }

  async function markInvoked(run: Run) {
    await db.update(heartbeatProgressOutcomes).set({ modelInvoked: true })
      .where(and(eq(heartbeatProgressOutcomes.runId, run.id), isNull(heartbeatProgressOutcomes.finishedAt)));
  }

  async function skipped(run: Run, reason: string) {
    await db.insert(heartbeatProgressOutcomes).values({ companyId: run.companyId, agentId: run.agentId,
      runId: run.id, generation: 0, outcome: "skipped_preflight", reason, finishedAt: new Date(),
    }).onConflictDoUpdate({ target: heartbeatProgressOutcomes.runId,
      set: { outcome: "skipped_preflight", reason, modelInvoked: false, finishedAt: new Date() } });
  }

  async function finish(run: Run) {
    if (!["succeeded", "failed", "cancelled", "timed_out", "interrupted"].includes(run.status)) return;
    const observed = await db.select().from(heartbeatProgressOutcomes).where(and(
      eq(heartbeatProgressOutcomes.runId, run.id), eq(heartbeatProgressOutcomes.companyId, run.companyId),
      eq(heartbeatProgressOutcomes.agentId, run.agentId),
    )).then(rows => rows[0]);
    if (!observed || observed.finishedAt) return;
    const agent = await db.select().from(agents).where(and(eq(agents.id, run.agentId), eq(agents.companyId, run.companyId))).then(r => r[0]);
    if (!agent) return;
    const current = await snapshot(agent, { source: "timer" });
    await db.transaction(async tx => {
      const state = await lockState(tx as unknown as Db, agent);
      const record = await tx.select().from(heartbeatProgressOutcomes).where(eq(heartbeatProgressOutcomes.runId, run.id)).then(r => r[0]);
      if (!record || record.finishedAt) return;
      const events = await tx.select().from(activityLog).where(and(eq(activityLog.companyId, run.companyId),
        eq(activityLog.runId, run.id), eq(activityLog.entityType, "issue"),
        inArray(activityLog.action, ["issue.updated", "issue.work_product_created", "issue.work_product_updated", "issue.document_upserted", "issue.document_updated", "issue.attachment_added"])));
      let delivered = false;
      for (const event of events) {
        const details = object(event.details);
        const previous = object(details._previous);
        const statusChange = object(object(details.changes).status);
        const before = previous.status ?? statusChange.from ?? statusChange.before;
        const after = details.status ?? statusChange.to ?? statusChange.after;
        const kind = before && before !== "done" && after === "done" ? "task_completed" :
          before === "blocked" && ["todo", "in_progress", "in_review"].includes(String(after)) ? "blocker_resolved" : null;
        if (!kind) continue;
        const readiness = await deps.readiness(run.companyId, [event.entityId], tx as unknown as Db);
        if (kind === "blocker_resolved" && !readiness.get(event.entityId)?.isDependencyReady) continue;
        const inserted = await tx.insert(heartbeatDeliveredTransitions).values({ companyId: run.companyId,
          agentId: run.agentId, runId: run.id, issueId: event.entityId, kind,
          transitionKey: kind === "task_completed" ? `completion:${event.entityId}` : `resolution:${event.id}`,
        }).onConflictDoNothing().returning();
        delivered ||= inserted.length > 0;
      }
      const outcome = delivered ? "delivered_progress" : !record.modelInvoked ? "skipped_preflight" :
        run.status !== "succeeded" ? "failed" : events.some(e => e.action !== "issue.updated" || Object.keys(object(object(e.details).changes)).length > 0) ? "worked" : "no_op";
      const usage = object(run.usageJson);
      const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
      await tx.update(heartbeatProgressOutcomes).set({ outcome, reason: outcome, finishedAt: run.finishedAt ?? new Date(),
        inputTokens: number(usage.inputTokens), outputTokens: number(usage.outputTokens),
        costUsd: usage.costStatus === "unpriced" || usage.billingType === "subscription_included" ? null : number(usage.costUsd),
      }).where(eq(heartbeatProgressOutcomes.runId, run.id));
      // An older concurrent run must never restore suppression after newer input.
      if (record.generation === state.generation) {
        const consecutiveNoOps = outcome === "no_op" && !current.actionable ? state.consecutiveNoOps + 1 : 0;
        await tx.update(heartbeatProgressState).set({ consecutiveNoOps,
          timersSuppressed: consecutiveNoOps >= 2, updatedAt: new Date(),
        }).where(eq(heartbeatProgressState.agentId, agent.id));
      }
    });
  }

  async function summary(companyId: string, agentId: string): Promise<HeartbeatProgressSummary> {
    const [state] = await db.select().from(heartbeatProgressState).where(and(eq(heartbeatProgressState.companyId, companyId), eq(heartbeatProgressState.agentId, agentId)));
    const [counts] = await db.select({
      modelRuns: sql<number>`count(*) filter (where ${heartbeatProgressOutcomes.modelInvoked})::int`,
      noOpRuns: sql<number>`count(*) filter (where ${heartbeatProgressOutcomes.outcome} = 'no_op')::int`,
      skipped: sql<number>`count(*) filter (where ${heartbeatProgressOutcomes.outcome} = 'skipped_preflight')::int`,
      successfulTurns: sql<number>`count(*) filter (where ${heartbeatRuns.status} = 'succeeded' and ${heartbeatProgressOutcomes.modelInvoked})::int`,
      inputTokens: sql<number>`coalesce(sum(${heartbeatProgressOutcomes.inputTokens}),0)::float8`,
      outputTokens: sql<number>`coalesce(sum(${heartbeatProgressOutcomes.outputTokens}),0)::float8`,
      measuredCostUsd: sql<number>`coalesce(sum(${heartbeatProgressOutcomes.costUsd}),0)::float8`,
      unknownCostRuns: sql<number>`count(*) filter (where ${heartbeatProgressOutcomes.modelInvoked} and ${heartbeatProgressOutcomes.costUsd} is null)::int`,
    }).from(heartbeatProgressOutcomes).innerJoin(heartbeatRuns, eq(heartbeatRuns.id, heartbeatProgressOutcomes.runId))
      .where(and(eq(heartbeatProgressOutcomes.companyId, companyId), eq(heartbeatProgressOutcomes.agentId, agentId)));
    const [skips] = await db.select({ count: sql<number>`count(*)::int` }).from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId),
        eq(agentWakeupRequests.status, "skipped"), sql`${agentWakeupRequests.payload}->'heartbeatSkip'->>'outcome' = 'skipped_preflight'`));
    const [transitions] = await db.select({
      completed: sql<number>`count(*) filter (where ${heartbeatDeliveredTransitions.kind} = 'task_completed')::int`,
      resolved: sql<number>`count(*) filter (where ${heartbeatDeliveredTransitions.kind} = 'blocker_resolved')::int`,
    }).from(heartbeatDeliveredTransitions).where(and(eq(heartbeatDeliveredTransitions.companyId, companyId), eq(heartbeatDeliveredTransitions.agentId, agentId)));
    return { version: 1, consecutiveNoOps: state?.consecutiveNoOps ?? 0, timersSuppressed: state?.timersSuppressed ?? false,
      modelRuns: counts!.modelRuns, skippedPreflight: counts!.skipped + skips!.count, noOpRuns: counts!.noOpRuns,
      successfulTurns: counts!.successfulTurns, uniqueTaskCompletions: transitions!.completed, blockerResolutions: transitions!.resolved,
      inputTokens: counts!.inputTokens, outputTokens: counts!.outputTokens, measuredCostUsd: counts!.measuredCostUsd, unknownCostRuns: counts!.unknownCostRuns };
  }
  return { evaluate, wakeForRun, markInvoked, skipped, finish, summary };
}
