import fs from "node:fs/promises";
import path from "node:path";
import { reservePersistentControlPlaneWrite, readControlPlaneIntents } from "@paperclipai/adapter-utils/control-plane-intents";
import { PaperclipRunnerToolAuthority } from "../services/native-runtime/paperclip-runner-tool-authority.js";
import { withControlPlaneStorage, reconcileControlPlaneOutages } from "../services/control-plane-outage.js";
import { reconcileIncidentNotifications } from "../services/control-plane-incident-outbox.js";
import { randomUUID, createHash } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agentWakeupRequests, agentApiKeys, agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase, getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { actorMiddleware } from "../middleware/auth.js";
import { controlPlaneWriteGuard } from "../middleware/control-plane-write-guard.js";
import { errorHandler } from "../middleware/error-handler.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { observeCrossIssueInfluence } from "../services/cross-issue-influence-limit.js";
import { reserveControlPlaneWrite, settleControlPlaneWrite } from "../services/control-plane-write-budget.js";
import { classifyControlPlaneFailure, operationFingerprint } from "../services/control-plane-failures.js";

const support = await getEmbeddedPostgresTestSupport();
describe("validated write and incident durability", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    expect(support.supported).toBe(true);
    temp = await startEmbeddedPostgresTestDatabase("paperclip-write-reliability-");
    db = createDb(temp.connectionString);
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "isolated-reliability-test-secret");
  }, 90_000);
  afterAll(async () => { vi.unstubAllEnvs(); await temp?.cleanup(); });
  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Test", issueCounter: 1, issuePrefix: `T${companyId.slice(0, 7)}`, defaultResponsibleUserId: "test-board" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Operator", role: "cto", status: "idle", adapterType: "codex_local" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Source", identifier: `T${companyId.slice(0, 7).toUpperCase()}-1`, assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", nativeIssueId: issueId, contextSnapshot: {}, responsibleUserId: "test-board" });
    return { companyId, agentId, runId, issueId };
  }
  function app(notify?: Parameters<typeof controlPlaneWriteGuard>[1]) {
    const app = express(); app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "authenticated" }));
    app.use(controlPlaneWriteGuard(db, notify));
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
  it.each(["case", "slash", "identifier", "encoding", "compact", "braces", "identifier-space"])("shares the persisted budget across %s aliases", async (alias) => {
    const s = await seed();
    const base = `/api/issues/${s.issueId}/comments`;
    const aliases = {
      "identifier-space": `/api/issues/%20T${s.companyId.slice(0, 7).toUpperCase()}-1%20/comments`,
      case: `/API/ISSUES/${s.issueId.toUpperCase()}/COMMENTS`,
      slash: `${base}/`,
      compact: `/api/issues/${s.issueId.replaceAll("-", "")}/comments`,
      braces: `/api/issues/%7B${s.issueId}%7D/comments`,
      identifier: `/api/issues/t${s.companyId.slice(0, 7)}-1/comments`,
      encoding: `/api/issues/%${s.issueId.charCodeAt(0).toString(16)}${s.issueId.slice(1)}/comments`,
    };
    for (const [index, route] of [base, base, aliases[alias as keyof typeof aliases]].entries()) {
      const res = await request(app()).post(route).set("Authorization", `Bearer ${token(s)}`).send({ fail: true });
      expect(res.status).toBe(index < 2 ? 503 : 409);
    }
  });
  it("persists recurrence notifications, recovers crash-after-enqueue and serializes concurrent workers", async () => {
    const s = await seed();
    const failure = classifyControlPlaneFailure({ status: 503 });
    const report = async (runId: string) => {
      const reservationId = await reserveControlPlaneWrite(db, { ...s, runId, fingerprint: "outbox-test" });
      return settleControlPlaneWrite(db, { ...s, runId, reservationId, failure });
    };
    const incident = (await report(s.runId))!;
    const send = vi.fn(async (notification) => {
      await db.insert(agentWakeupRequests).values({ companyId: s.companyId, agentId: s.agentId,
        source: "on_demand", reason: "issue_assigned", idempotencyKey: notification.idempotencyKey,
        payload: { issueId: notification.issueId },
      });
      throw new Error("simulated crash after durable enqueue before ack");
    });
    await Promise.all(Array.from({ length: 6 }, () => reconcileIncidentNotifications(db, send, { companyId: s.companyId })));
    expect(send).toHaveBeenCalledTimes(1);
    const fresh = createDb(temp.connectionString);
    await reconcileIncidentNotifications(fresh, send, { companyId: s.companyId, now: Date.now() + 60_000 });
    expect(send).toHaveBeenCalledTimes(1);
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, incident.issueId));
    await report(s.runId);
    await reconcileIncidentNotifications(fresh, send, { companyId: s.companyId });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0].idempotencyKey).not.toBe(send.mock.calls[1][0].idempotencyKey);
    const receipts = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, s.companyId));
    expect(receipts).toHaveLength(2);
    await expect(db.insert(agentWakeupRequests).values({ companyId: s.companyId, agentId: s.agentId,
      source: "on_demand", idempotencyKey: receipts[0].idempotencyKey,
    })).rejects.toThrow();
  });
  it("retries unavailable notifications with a bound and retains exhausted intent", async () => {
    const s = await seed();
    const reservationId = await reserveControlPlaneWrite(db, { ...s, fingerprint: "unavailable" });
    await settleControlPlaneWrite(db, { ...s, reservationId, failure: classifyControlPlaneFailure({ status: 503 }) });
    const send = vi.fn(async () => new Promise(() => {}));
    for (let i = 0; i < 10; i++) await reconcileIncidentNotifications(db, send, { companyId: s.companyId, now: Date.now() + i * 600_000, timeoutMs: 2 });
    expect(send).toHaveBeenCalledTimes(8);
    const [intent] = await db.select().from(activityLog).where(and(eq(activityLog.companyId, s.companyId), eq(activityLog.action, "control_plane.notification_pending")));
    expect(intent.details?.attempts).toBe(8);
  });
  it("replays only durable incident intent after restart, keeping the two-failure transport budget", async () => {
    const s = await seed();
    const directory = await fs.mkdtemp(path.join(process.env.PAPERCLIP_SCRATCH_DIR ?? process.env.TMPDIR!, "outage-"));
    const slots = await Promise.allSettled(Array.from({ length: 8 }, () => reservePersistentControlPlaneWrite(s.runId, "transport", directory)));
    const admitted = slots.filter((slot) => slot.status === "fulfilled");
    expect(admitted).toHaveLength(2);
    for (const slot of admitted) await slot.value.fail();
    expect(await readControlPlaneIntents(directory)).toHaveLength(2);
    const fresh = createDb(temp.connectionString);
    await reconcileControlPlaneOutages(fresh, directory);
    await reconcileControlPlaneOutages(fresh, directory);
    const [summary] = await db.select().from(activityLog).where(and(eq(activityLog.companyId, s.companyId), eq(activityLog.action, "control_plane.incident_summary")));
    expect(summary.details?.occurrences).toBe(2);
    await expect(reservePersistentControlPlaneWrite(s.runId, "transport", directory)).rejects.toThrow("control_plane_write_budget_exhausted");
    const serialized = JSON.stringify(await readControlPlaneIntents(directory));
    expect(serialized).not.toMatch(/body|token|exception|headers/);
  });

  it("fails closed after two storage outages and reports them durably after recovery", async () => {
    const s = await seed();
    const work = vi.fn(async () => { throw new Error("synthetic-storage-token-must-not-persist"); });
    for (let i = 0; i < 2; i++) await expect(withControlPlaneStorage(s, work)).rejects.toMatchObject({ status: 503 });
    await expect(withControlPlaneStorage(s, work)).rejects.toMatchObject({ status: 409 });
    expect(work).toHaveBeenCalledTimes(2);
    await reconcileControlPlaneOutages(createDb(temp.connectionString));
    await reconcileControlPlaneOutages(createDb(temp.connectionString));
    const [summary] = await db.select().from(activityLog).where(and(eq(activityLog.companyId, s.companyId), eq(activityLog.action, "control_plane.incident_summary")));
    expect(summary.details?.occurrences).toBe(2);
    expect(JSON.stringify(await readControlPlaneIntents())).not.toContain("synthetic-storage-token");
  });
  it("contains native call_api transport failures across resource aliases and new authorities", async () => {
    const s = await seed();
    await db.update(heartbeatRuns).set({ runtimeMode: "native" }).where(eq(heartbeatRuns.id, s.runId));
    await db.update(issues).set({ executionRunId: s.runId, workMode: "standard" }).where(eq(issues.id, s.issueId));
    vi.stubEnv("PAPERCLIP_RUNNER_API_TOOLS_ENABLED", "true");
    vi.stubEnv("PAPERCLIP_RUNNER_API_TOOLS_COMPANY_IDS", s.companyId);
    const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("synthetic-transport-secret"));
    try {
      for (let i = 0; i < 3; i++) {
        const authority = new PaperclipRunnerToolAuthority(createDb(temp.connectionString), { ...s, apiToolsEnabled: true,
          apiUrl: "http://127.0.0.1:1", workspaceRoot: process.env.PAPERCLIP_SCRATCH_DIR!, executionTargetKind: "local" });
        const call = authority.execute({ tool: "call_api", callId: `transport-${i}`, arguments: {
          operationId: "POST /api/issues/{id}/comments", pathParams: { id: i === 2 ? `T${s.companyId.slice(0, 7).toUpperCase()}-1` : s.issueId }, body: { body: "test" },
        } });
        if (i < 2) await expect(call).resolves.toMatchObject({ error: "api_transport_failure", outcome: "unknown" });
        else await expect(call).rejects.toMatchObject({ status: 409 });
      }
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally { fetcher.mockRestore(); }
  });

  it("does not hold HTTP completion open for an unavailable notification sink", async () => {
    const s = await seed();
    const notify = vi.fn(async () => new Promise(() => {}));
    const response = await request(app(notify)).post(`/api/issues/${s.issueId}/comments`)
      .set("Authorization", `Bearer ${token(s)}`).send({ fail: true }).timeout(1500);
    expect(response.status).toBe(503);
  });
  it("retains a policy-skipped wake for retry without changing its recurrence key", async () => {
    const s = await seed();
    const reservationId = await reserveControlPlaneWrite(db, { ...s, fingerprint: "skipped-wake" });
    await settleControlPlaneWrite(db, { ...s, reservationId, failure: classifyControlPlaneFailure({ status: 503 }) });
    let attempt = 0;
    const send = vi.fn(async (notification) => {
      await db.insert(agentWakeupRequests).values({ companyId: s.companyId, agentId: s.agentId,
        source: "on_demand", idempotencyKey: notification.idempotencyKey, status: attempt++ === 0 ? "skipped" : "queued" });
    });
    await reconcileIncidentNotifications(db, send, { companyId: s.companyId });
    await reconcileIncidentNotifications(createDb(temp.connectionString), send, { companyId: s.companyId, now: Date.now() + 60_000 });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0].idempotencyKey).toBe(send.mock.calls[1][0].idempotencyKey);
    const [row] = await db.select().from(activityLog).where(and(eq(activityLog.companyId, s.companyId), eq(activityLog.action, "control_plane.notification_delivered")));
    expect(row).toBeDefined();
  });

});
