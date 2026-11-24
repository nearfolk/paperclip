import { randomUUID, createHash } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agentApiKeys, agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase, getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { actorMiddleware } from "../middleware/auth.js";
import { controlPlaneWriteGuard } from "../middleware/control-plane-write-guard.js";
import { errorHandler } from "../middleware/error-handler.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { observeCrossIssueInfluence } from "../services/cross-issue-influence-limit.js";
import { reserveControlPlaneWrite, settleControlPlaneWrite } from "../services/control-plane-write-budget.js";
import { classifyControlPlaneFailure, operationFingerprint } from "../services/control-plane-failures.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("validated write and incident durability", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-write-reliability-");
    db = createDb(temp.connectionString);
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "isolated-reliability-test-secret");
  }, 90_000);
  afterAll(async () => { vi.unstubAllEnvs(); await temp?.cleanup(); });
  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Test", issuePrefix: `T${companyId.slice(0, 7)}`, defaultResponsibleUserId: "test-board" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Operator", role: "cto", status: "idle", adapterType: "codex_local" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Source", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", nativeIssueId: issueId, contextSnapshot: {}, responsibleUserId: "test-board" });
    return { companyId, agentId, runId, issueId };
  }
  function app() {
    const app = express(); app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "authenticated" }));
    app.use(controlPlaneWriteGuard(db));
    app.post("/api/issues/:id/comments", async (req, res) => {
      const actor = req.actor;
      if (actor.type !== "agent") return res.sendStatus(401);
      await observeCrossIssueInfluence(db, { companyId: actor.companyId!, agentId: actor.agentId!, runId: actor.runId!, targetIssueId: req.params.id, kind: "comment" });
      if (req.body.fail) return res.status(503).json({ error: "synthetic outage" });
      return res.json({ accepted: true });
    });
    app.use(errorHandler); return app;
  }
  function token(s: Awaited<ReturnType<typeof seed>>) { return createLocalAgentJwt(s.agentId, s.companyId, "codex_local", s.runId, "test-board")!; }
  it("accepts a supplied JWT/header for native-only source binding and preserves legacy binding", async () => {
    const s = await seed();
    expect((await request(app()).post(`/api/issues/${s.issueId}/comments`).set("Authorization", `Bearer ${token(s)}`).set("X-Paperclip-Run-Id", s.runId).send({})).status).toBe(200);
    await db.update(heartbeatRuns).set({ nativeIssueId: null, contextSnapshot: { taskId: s.issueId } }).where(eq(heartbeatRuns.id, s.runId));
    expect((await request(app()).post(`/api/issues/${s.issueId}/comments`).set("Authorization", `Bearer ${token(s)}`).send({})).status).toBe(200);
  });
  it("normalizes API-key headers but rejects missing/malformed, wrong agent, wrong company and terminal runs", async () => {
    const s = await seed(), other = await seed();
    const key = `test-${randomUUID()}`;
    await db.insert(agentApiKeys).values({ companyId: s.companyId, agentId: s.agentId, name: "Test", keyHash: createHash("sha256").update(key).digest("hex"), responsibleUserId: "test-board" });
    const send = (header?: string) => { const r = request(app()).post(`/api/issues/${s.issueId}/comments`).set("Authorization", `Bearer ${key}`); return (header ? r.set("X-Paperclip-Run-Id", header) : r).send({}); };
    expect((await send(` ${s.runId} `)).status).toBe(200);
    for (const header of [undefined, "malformed", other.runId]) expect((await send(header)).status).toBe(403);
    await db.update(heartbeatRuns).set({ agentId: other.agentId }).where(eq(heartbeatRuns.id, s.runId));
    expect((await send(s.runId)).status).toBe(403);
    await db.update(heartbeatRuns).set({ agentId: s.agentId, status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, s.runId));
    expect((await send(s.runId)).status).toBe(403);
  });
  it("rejects JWT/header mismatch and conflicting/missing/superseded persisted source", async () => {
    const s = await seed(), other = await seed();
    const send = (header = s.runId) => request(app()).post(`/api/issues/${s.issueId}/comments`).set("Authorization", `Bearer ${token(s)}`).set("X-Paperclip-Run-Id", header).send({});
    expect((await send(other.runId)).status).toBe(422);
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: other.issueId } }).where(eq(heartbeatRuns.id, s.runId));
    expect((await send()).status).toBe(403);
    await db.update(heartbeatRuns).set({ nativeIssueId: null, contextSnapshot: {} }).where(eq(heartbeatRuns.id, s.runId));
    expect((await send()).status).toBe(403);
    await db.update(heartbeatRuns).set({ nativeIssueId: s.issueId }).where(eq(heartbeatRuns.id, s.runId));
    await db.update(issues).set({ executionRunId: other.runId }).where(eq(issues.id, s.issueId));
    expect((await send()).status).toBe(409);
    const fresh = await seed();
    await db.update(issues).set({ executionRunId: other.runId }).where(eq(issues.id, fresh.issueId));
    expect((await request(app()).post(`/api/issues/${fresh.issueId}/comments`).set("Authorization", `Bearer ${token(fresh)}`).send({})).status).toBe(403);
  });
  it("stops the third failed HTTP write, survives a new app/client, and records one incident with two occurrences", async () => {
    const s = await seed();
    for (let i = 0; i < 3; i++) {
      const res = await request(app()).post(`/api/issues/${s.issueId}/comments`).set("Authorization", `Bearer ${token(s)}`).set("X-Paperclip-Run-Id", s.runId).send({ fail: true, secret: `must-not-persist-${i}` });
      expect(res.status).toBe(i < 2 ? 503 : 409);
    }
    const fresh = createDb(temp.connectionString);
    const incidents = await fresh.select().from(issues).where(and(eq(issues.companyId, s.companyId), eq(issues.originKind, "control_plane_incident")));
    expect(incidents).toHaveLength(1);
    const summaries = await fresh.select().from(activityLog).where(and(eq(activityLog.companyId, s.companyId), eq(activityLog.action, "control_plane.incident_summary")));
    expect(summaries[0].details?.occurrences).toBe(2);
    expect(incidents[0].assigneeAgentId).toBe(s.agentId);
    expect(JSON.stringify(incidents)).not.toContain("must-not-persist");
    const ledger = await fresh.select().from(activityLog).where(eq(activityLog.runId, s.runId));
    expect(JSON.stringify(ledger)).not.toContain("must-not-persist");
  });
  it("serializes concurrent reservations and deduplicates incidents across reporters after restart", async () => {
    const s = await seed();
    const fingerprint = operationFingerprint("PATCH", `/api/issues/${s.issueId}`);
    const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => reserveControlPlaneWrite(db, { ...s, fingerprint })));
    const admitted = attempts.filter((x): x is PromiseFulfilledResult<string> => x.status === "fulfilled");
    expect(admitted).toHaveLength(2);
    const failure = classifyControlPlaneFailure({ error: { cause: { code: "ECONNRESET", message: "secret" } } });
    await Promise.all(admitted.map((r) => settleControlPlaneWrite(db, { ...s, reservationId: r.value, failure })));
    // A new connection and a different heartbeat must share the same incident.
    const fresh = createDb(temp.connectionString), nextRun = randomUUID();
    await fresh.insert(heartbeatRuns).values({ id: nextRun, companyId: s.companyId, agentId: s.agentId, status: "running", nativeIssueId: s.issueId });
    const reservationId = await reserveControlPlaneWrite(fresh, { ...s, runId: nextRun, fingerprint });
    await settleControlPlaneWrite(fresh, { ...s, runId: nextRun, reservationId, failure });
    await settleControlPlaneWrite(fresh, { ...s, runId: nextRun, reservationId, failure });
    const rows = await fresh.select().from(issues).where(and(eq(issues.companyId, s.companyId), eq(issues.originKind, "control_plane_incident")));
    expect(rows).toHaveLength(1); const summaries = await fresh.select().from(activityLog).where(and(eq(activityLog.companyId, s.companyId), eq(activityLog.action, "control_plane.incident_summary")));
    expect(summaries[0].details?.occurrences).toBe(3);
    await expect(reserveControlPlaneWrite(fresh, { ...s, fingerprint })).rejects.toMatchObject({ details: { code: "control_plane_write_budget_exhausted" } });
  });
});
