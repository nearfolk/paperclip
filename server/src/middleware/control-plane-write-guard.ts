import { isUuidLike } from "@paperclipai/shared";
import { withControlPlaneStorage } from "../services/control-plane-outage.js";
import { reconcileIncidentNotifications, type IncidentNotification } from "../services/control-plane-incident-outbox.js";
import type { RequestHandler } from "express";
import type { Db } from "@paperclipai/db";
import { classifyControlPlaneFailure } from "../services/control-plane-failures.js";
import { reserveControlPlaneWrite, settleControlPlaneWrite } from "../services/control-plane-write-budget.js";
import { validateAgentWriteRun, invalidRunContext } from "../services/validated-run-context.js";
import { issueWriteRoute, issueWriteFingerprint } from "../services/control-plane-route.js";
import { logger } from "./logger.js";

/** The guard never retries a mutation. It stops repeated attempts before routes. */
export function controlPlaneWriteGuard(db: Db, notify?: (incident: IncidentNotification) => Promise<unknown>): RequestHandler {
  return async (req, res, next) => {
    if (req.actor.type !== "agent" || !issueWriteRoute(req.method, req.path)) return next();
    if (!req.actor.agentId || !req.actor.companyId || !req.actor.runId || !isUuidLike(req.actor.runId)) throw invalidRunContext();
    const identity = { agentId: req.actor.agentId, companyId: req.actor.companyId, runId: req.actor.runId };
    const reservationId = await withControlPlaneStorage(identity, async () => reserveControlPlaneWrite(db, { ...identity, fingerprint: await issueWriteFingerprint(db, identity.companyId, req.method, req.path) }));
    const json = res.json.bind(res);
    const end = res.end.bind(res);
    let responseCode: unknown;
    let settling = false;
    res.json = ((body: unknown) => {
      const payload = body && typeof body === "object" ? body as { code?: unknown; details?: { code?: unknown } } : {};
      responseCode = payload.code ?? payload.details?.code;
      return json(body);
    }) as typeof res.json;
    res.end = ((...args: Parameters<typeof res.end>) => {
      if (settling) return res;
      settling = true;
      const failure = res.statusCode >= 400 ? classifyControlPlaneFailure({ status: res.statusCode, code: responseCode, error: res.locals.controlPlaneError }) : undefined;
      const completionTimer = setTimeout(() => { if (!res.writableEnded) end(...args); }, 5000);
      void withControlPlaneStorage(identity, () => settleControlPlaneWrite(db, { ...identity, reservationId, failure }), reservationId).then(() => {
        if (notify) void reconcileIncidentNotifications(db, notify).catch(() => undefined);
      }).catch(() => {
        // The durable reservation stays charged if settlement is unavailable.
        // Never log the exception: drivers can include SQL values and secrets.
        logger.warn({ runId: identity.runId }, "Control-plane write settlement unavailable");
      }).finally(() => { clearTimeout(completionTimer); if (!res.writableEnded) end(...args); });
      return res;
    }) as typeof res.end;
    await validateAgentWriteRun(db, identity);
    next();
  };
}
