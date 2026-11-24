import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, issues, issueRelations, issueComments, heartbeatRuns,
  heartbeatProgressState, heartbeatProgressOutcomes, agentWakeupRequests, activityLog,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatProgressService, relevantCommentKey } from "../services/heartbeat-progress.js";
import { issueService } from "../services/issues.js";
import { issueTreeControlService } from "../services/issue-tree-control.js";
import { heartbeatService } from "../services/heartbeat.js";

const execute = vi.hoisted(() => vi.fn(async () => ({ exitCode: 0, signal: null, timedOut: false })));
const hydrate = vi.hoisted(() => vi.fn(async () => null));
vi.mock("../adapters/index.ts", async () => ({
  ...await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts"),
  getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute })),
}));
vi.mock("../services/issue-continuation-summary.js", async () => ({
  ...await vi.importActual<typeof import("../services/issue-continuation-summary.js")>("../services/issue-continuation-summary.js"),
  getIssueContinuationSummaryDocument: hydrate,
}));

describe("persistent heartbeat progress admission", () => {
  let db: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let service: ReturnType<typeof heartbeatProgressService>;
  let agent: typeof agents.$inferSelect;
  let block: string | null = null;
  const makeService = () => heartbeatProgressService(db, {
    readiness: (company, ids, tx) => issueService(db).listDependencyReadiness(company, ids, tx),
    held: (company, id) => issueTreeControlService(db).getActivePauseHoldGate(company, id),
    invocationBlock: async fresh => ["paused", "terminated"].includes(fresh.status) ? "agent.not_invokable" : block,
  });
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("heartbeat-progress-");
    db = createDb(temp.connectionString);
  }, 60000);
  afterAll(async () => { await temp?.cleanup(); });
  afterEach(async () => {
    await heartbeatService(db).drainActiveRunExecutions();
    await db.execute(sql`truncate companies cascade`);
    vi.clearAllMocks(); block = null;
  });
  async function seed() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "progress fixture", issuePrefix: `P${companyId.slice(0,6)}`,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "human" });
    [agent] = await db.insert(agents).values({ companyId, name: "worker", role: "engineer", status: "active",
      adapterType: "codex_local", adapterConfig: { instructionsFilePath: "/tmp/progress-instructions.md" },
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true, skipTimerWhenNoActionableWork: true } },
    }).returning();
    service = makeService();
  }
  async function issue(status = "todo") {
    return db.insert(issues).values({ companyId: agent.companyId, title: "work", status,
      assigneeAgentId: agent.id, responsibleUserId: "human" }).returning().then(rows => rows[0]!);
  }
  async function run(issueId?: string) {
    return db.insert(heartbeatRuns).values({ companyId: agent.companyId, agentId: agent.id,
      status: "running", invocationSource: "on_demand", startedAt: new Date(), contextSnapshot: { issueId },
    }).returning().then(rows => rows[0]!);
  }
  async function comment(issueId: string, body: string, metadata = {}) {
    return db.insert(issueComments).values({ companyId: agent.companyId, issueId, body, authorUserId: "human", metadata })
      .returning().then(rows => rows[0]!);
  }
  async function finish(r: Awaited<ReturnType<typeof run>>, usageJson: Record<string, unknown> | null = null, status = "succeeded") {
    const [updated] = await db.update(heartbeatRuns).set({ status, exitCode: status === "succeeded" ? 0 : 1,
      finishedAt: new Date(), usageJson }).where(eq(heartbeatRuns.id, r.id)).returning();
    await service.finish(updated!);
  }

  it.each(["todo", "in_progress", "blocked"])("skips unchanged %s dependency queues before adapter and hydration", async status => {
    await seed(); const target = await issue(status); const blocker = await issue("blocked");
    await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, blocker.id));
    await db.insert(issueRelations).values({ companyId: agent.companyId, issueId: blocker.id, relatedIssueId: target.id, type: "blocks" });
    const read = vi.spyOn(fs, "readFile");
    const heartbeat = heartbeatService(db);
    for (let attempt = 0; attempt < 3; attempt++) await heartbeat.wakeup(agent.id, { source: "timer", reason: "heartbeat_timer" });
    const c = await comment(target.id, "Please resume this task");
    for (const source of ["on_demand", "automation"] as const) await heartbeat.wakeup(agent.id, {
      source, reason: "issue_commented", requestedByActorType: "user", requestedByActorId: "human",
      contextSnapshot: { issueId: target.id, wakeCommentId: c.id },
    });
    expect(execute).not.toHaveBeenCalled(); expect(hydrate).not.toHaveBeenCalled();
    expect(read.mock.calls.some(([file]) => String(file) === "/tmp/progress-instructions.md")).toBe(false);
    read.mockRestore();
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
    expect((await service.summary(agent.companyId, agent.id)).skippedPreflight).toBe(5);
  });

  it("resumes assignment, human context, dependency resolution and manual requests", async () => {
    await seed();
    expect((await service.evaluate(agent, { source: "timer" })).allowed).toBe(false);
    const target = await issue();
    expect((await service.evaluate(agent, { source: "assignment", issueId: target.id })).allowed).toBe(true);
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, target.id));
    const c = await comment(target.id, "Please check the revised requirement");
    expect((await service.evaluate(agent, { source: "automation", issueId: target.id, commentId: c.id })).allowed).toBe(true);
    const blocker = await issue("todo");
    await db.insert(issueRelations).values({ companyId: agent.companyId, issueId: blocker.id, relatedIssueId: target.id, type: "blocks" });
    expect((await service.evaluate(agent, { source: "on_demand", actorType: "user", eventId: randomUUID(), issueId: target.id })).allowed).toBe(false);
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, blocker.id));
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, target.id));
    expect((await service.evaluate(agent, { source: "automation", issueId: target.id })).allowed).toBe(true);
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, target.id));
    expect((await service.evaluate(agent, { source: "on_demand", actorType: "user", eventId: randomUUID(), issueId: target.id })).allowed).toBe(true);
  });

  it("deduplicates normalized comments across ids, restarts and concurrent claims", async () => {
    await seed(); const target = await issue("blocked");
    const c = await comment(target.id, "Please do the new action");
    const wake = { source: "automation", issueId: target.id, commentId: c.id };
    const a = await run(target.id); const b = await run(target.id);
    const decisions = await Promise.all([service.evaluate(agent, wake, a.id, true), service.evaluate(agent, wake, b.id, true)]);
    expect(decisions.filter(d => d.allowed)).toHaveLength(1);
    service = makeService();
    const duplicate = await comment(target.id, "  PLEASE do the new action  ");
    expect(await service.evaluate(agent, { ...wake, commentId: duplicate.id })).toMatchObject({ allowed: false, reason: "duplicate_context" });
    for (const text of ["thanks", "ping", "reminder"]) {
      const irrelevant = await comment(target.id, text);
      expect((await service.evaluate(agent, { ...wake, commentId: irrelevant.id })).allowed).toBe(false);
    }
    expect(relevantCommentKey({ ...c, authorAgentId: agent.id }, agent.id, target.id)).toBeNull();
  });

  it("persists two no-ops, excludes skipped wakes, resets on new work and fences old completions", async () => {
    await seed(); const target = await issue();
    const a = await run(target.id); const b = await run(target.id);
    await service.evaluate(agent, { source: "assignment", issueId: target.id }, a.id, true);
    await service.evaluate(agent, { source: "assignment", issueId: target.id }, b.id, true);
    await service.markInvoked(a); await service.markInvoked(b);
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, target.id));
    await finish(a); service = makeService(); await finish(b);
    expect(await service.summary(agent.companyId, agent.id)).toMatchObject({ consecutiveNoOps: 2, timersSuppressed: true, noOpRuns: 2, unknownCostRuns: 2 });
    expect(await service.evaluate(agent, { source: "timer" })).toMatchObject({ allowed: false, reason: "timers_suppressed" });
    await service.finish({ ...b, status: "succeeded" }); // duplicate finalization is inert
    expect((await service.summary(agent.companyId, agent.id)).consecutiveNoOps).toBe(2);
    const fresh = await issue(); const c = await run(fresh.id);
    await service.evaluate(agent, { source: "assignment", issueId: fresh.id }, c.id, true);
    expect((await service.summary(agent.companyId, agent.id)).timersSuppressed).toBe(false);
    await db.update(heartbeatProgressOutcomes).set({ finishedAt: null }).where(eq(heartbeatProgressOutcomes.runId, a.id));
    await finish(a);
    expect((await service.summary(agent.companyId, agent.id)).consecutiveNoOps).toBe(0);
    const skipped = await run(); await service.skipped(skipped, "no_actionable_work");
    expect((await service.summary(agent.companyId, agent.id)).noOpRuns).toBe(2);
  });

  it("counts newly created documents as work without suppressing timers", async () => {
    await seed(); const target = await issue();
    const runs = [await run(target.id), await run(target.id)];
    for (const r of runs) {
      await service.evaluate(agent, { source: "assignment", issueId: target.id }, r.id, true);
      await service.markInvoked(r);
    }
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, target.id));
    for (const r of runs) {
      // The document-create route emits this action, independently of issue updates.
      await db.insert(activityLog).values({ companyId: agent.companyId, actorType: "agent",
        actorId: agent.id, agentId: agent.id, runId: r.id, entityType: "issue",
        entityId: target.id, action: "issue.document_created",
        details: { key: `receipt-${r.id}`, documentId: randomUUID(), revisionNumber: 1 },
      });
      await finish(r);
      service = makeService();
      expect(await db.select().from(heartbeatProgressOutcomes)
        .where(eq(heartbeatProgressOutcomes.runId, r.id))).toMatchObject([{ outcome: "worked" }]);
    }
    expect(await service.summary(agent.companyId, agent.id)).toMatchObject({
      noOpRuns: 0, consecutiveNoOps: 0, timersSuppressed: false, modelRuns: 2,
    });
  });

  it("separates unique delivered transitions, success, failure and unknown pricing", async () => {
    await seed(); const target = await issue(); const r = await run(target.id);
    await service.evaluate(agent, { source: "assignment", issueId: target.id }, r.id, true); await service.markInvoked(r);
    await db.insert(activityLog).values({ companyId: agent.companyId, actorType: "agent", actorId: agent.id, agentId: agent.id,
      runId: r.id, entityType: "issue", entityId: target.id, action: "issue.updated", details: { status: "done", _previous: { status: "in_progress" } } });
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, target.id));
    await finish(r, { inputTokens: 120, outputTokens: 30 }, "failed");
    expect(await service.summary(agent.companyId, agent.id)).toMatchObject({ modelRuns: 1, successfulTurns: 0,
      uniqueTaskCompletions: 1, unknownCostRuns: 1, measuredCostUsd: 0, inputTokens: 120, outputTokens: 30 });
    expect((await db.select().from(heartbeatProgressOutcomes))[0]?.outcome).toBe("delivered_progress");
    await service.finish({ ...r, status: "failed" });
    expect((await service.summary(agent.companyId, agent.id)).uniqueTaskCompletions).toBe(1);
  });


  it.each(["assignment", "comment", "dependency", "manual"] as const)("dispatches %s resumption through hydration and the adapter", async path => {
    await seed();
    const target = await issue(path === "comment" || path === "manual" || path === "dependency" ? "blocked" : "todo");
    if (path === "dependency") {
      const blocker = await issue("done");
      await db.insert(issueRelations).values({ companyId: agent.companyId, issueId: blocker.id, relatedIssueId: target.id, type: "blocks" });
    }
    const c = path === "comment" ? await comment(target.id, "Please implement the revised task") : null;
    await db.insert(heartbeatProgressState).values({ companyId: agent.companyId, agentId: agent.id, generation: 10,
      consecutiveNoOps: 2, timersSuppressed: true });
    execute.mockImplementationOnce(async () => {
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, target.id));
      return { exitCode: 0, signal: null, timedOut: false };
    });
    const heartbeat = heartbeatService(db);
    const result = await heartbeat.wakeup(agent.id, {
      source: path === "assignment" ? "assignment" : "on_demand", triggerDetail: path === "manual" ? "manual" : "system",
      reason: path === "dependency" ? "issue_blockers_resolved" : path === "comment" ? "issue_commented" : "issue_assigned",
      requestedByActorType: path === "manual" || path === "comment" ? "user" : "system", requestedByActorId: "human",
      contextSnapshot: { issueId: target.id, ...(c ? { wakeCommentId: c.id } : {}) },
    });
    expect(result).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();
    const runs = await db.select().from(heartbeatRuns);
    expect(runs.map(r => [r.status, r.errorCode, r.error])).not.toEqual([]);
    expect(execute, JSON.stringify(runs.map(r => ({ status: r.status, error: r.error })))).toHaveBeenCalledTimes(1);
    expect(hydrate).toHaveBeenCalled();
    expect((await service.summary(agent.companyId, agent.id)).timersSuppressed).toBe(false);
  }, 30000);

  it("cancels a queued manual wake when a dependency appears before claim without hydration", async () => {
    await seed(); const target = await issue(); const r = await run(target.id);
    await db.update(heartbeatRuns).set({ status: "queued" }).where(eq(heartbeatRuns.id, r.id));
    const blocker = await issue("blocked");
    await db.insert(issueRelations).values({ companyId: agent.companyId, issueId: blocker.id, relatedIssueId: target.id, type: "blocks" });
    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns(); await heartbeat.drainActiveRunExecutions();
    expect(execute).not.toHaveBeenCalled(); expect(hydrate).not.toHaveBeenCalled();
    expect(await db.select().from(heartbeatProgressOutcomes).where(eq(heartbeatProgressOutcomes.runId, r.id)))
      .toMatchObject([{ outcome: "skipped_preflight", reason: "issue_dependencies_blocked", modelInvoked: false }]);
  });

  it("revalidates immediately before dispatch when hydration races with a new blocker", async () => {
    await seed(); const target = await issue(); const blocker = await issue("blocked");
    hydrate.mockImplementationOnce(async () => {
      await db.insert(issueRelations).values({ companyId: agent.companyId, issueId: blocker.id, relatedIssueId: target.id, type: "blocks" });
      return null;
    });
    const heartbeat = heartbeatService(db);
    await heartbeat.wakeup(agent.id, { source: "assignment", reason: "issue_assigned", contextSnapshot: { issueId: target.id } });
    await heartbeat.drainActiveRunExecutions();
    expect(hydrate).toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
    expect((await db.select().from(heartbeatProgressOutcomes))[0]).toMatchObject({ outcome: "skipped_preflight", modelInvoked: false });
  }, 30000);

  it("records blocker resolution and measured cost once without treating subscription zero as free", async () => {
    await seed(); const target = await issue(); const r = await run(target.id);
    await service.evaluate(agent, { source: "assignment", issueId: target.id }, r.id, true); await service.markInvoked(r);
    await db.insert(activityLog).values({ companyId: agent.companyId, actorType: "agent", actorId: agent.id, agentId: agent.id,
      runId: r.id, entityType: "issue", entityId: target.id, action: "issue.updated", details: { status: "todo", _previous: { status: "blocked" } } });
    await finish(r, { inputTokens: 10, outputTokens: 2, costUsd: 0.03, costStatus: "reported" });
    expect(await service.summary(agent.companyId, agent.id)).toMatchObject({ blockerResolutions: 1, measuredCostUsd: 0.03, unknownCostRuns: 0 });
    const subscription = await run(target.id);
    await service.evaluate(agent, { source: "assignment", issueId: target.id }, subscription.id, true); await service.markInvoked(subscription);
    await finish(subscription, { inputTokens: 50, outputTokens: 5, costUsd: 0, billingType: "subscription_included" });
    expect(await service.summary(agent.companyId, agent.id)).toMatchObject({ blockerResolutions: 1, measuredCostUsd: 0.03, unknownCostRuns: 1 });
  });

  it("consumes relevant external field changes once and ignores self updates", async () => {
    await seed(); const target = await issue("blocked");
    await db.insert(activityLog).values({ companyId: agent.companyId, actorType: "user", actorId: "human", entityType: "issue",
      entityId: target.id, action: "issue.updated", details: { changes: { description: { from: "old", to: "new" } } } });
    const r = await run(target.id);
    expect((await service.evaluate(agent, { source: "automation", issueId: target.id }, r.id, true)).allowed).toBe(true);
    expect((await makeService().evaluate(agent, { source: "automation", issueId: target.id })).allowed).toBe(false);
    await db.insert(activityLog).values({ companyId: agent.companyId, actorType: "agent", actorId: agent.id, entityType: "issue",
      entityId: target.id, action: "issue.updated", details: { changes: { description: { from: "new", to: "reminder" } } } });
    expect((await service.evaluate(agent, { source: "automation", issueId: target.id })).allowed).toBe(false);
  });

  it("revalidates dependencies, review ownership, pause and budgets after admission", async () => {
    await seed(); const target = await issue("in_review"); const r = await run(target.id);
    expect((await service.evaluate(agent, { source: "assignment", issueId: target.id }, r.id, true)).allowed).toBe(true);
    await db.update(issues).set({ executionState: { currentParticipant: { type: "user", userId: "human" } } }).where(eq(issues.id, target.id));
    expect((await service.evaluate(agent, { source: "assignment", issueId: target.id }, r.id, true)).allowed).toBe(false);
    await db.update(issues).set({ executionState: null }).where(eq(issues.id, target.id));
    block = "budget.blocked";
    expect(await service.evaluate(agent, { source: "timer" })).toMatchObject({ allowed: false, reason: "budget.blocked" });
    block = null;
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, agent.id));
    expect(await service.evaluate(agent, { source: "timer" })).toMatchObject({ allowed: false, reason: "agent.not_invokable" });
  });
});
