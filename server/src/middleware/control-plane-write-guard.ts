import type { RequestHandler } from "express";
import type { Db } from "@paperclipai/db";
import { classifyControlPlaneFailure, operationFingerprint } from "../services/control-plane-failures.js";
import { reserveControlPlaneWrite, settleControlPlaneWrite } from "../services/control-plane-write-budget.js";
import { validateAgentWriteRun, invalidRunContext } from "../services/validated-run-context.js";
import { logger } from "./logger.js";

/** The guard never retries a mutation. It stops repeated attempts before routes. */
export function controlPlaneWriteGuard(db: Db, notify?: (incident: { issueId: string; ownerAgentId: string | null }) => Promise<unknown>): RequestHandler {
  return async (req, res, next) => {
    if (req.actor.type !== "agent" || ["GET", "HEAD", "OPTIONS"].includes(req.method) || !/(?:^|\/)issues(?:\/|$)/.test(req.path)) return next();
    if (!req.actor.agentId || !req.actor.companyId || !req.actor.runId) throw invalidRunContext();
    const identity = { agentId: req.actor.agentId, companyId: req.actor.companyId, runId: req.actor.runId };
    const reservationId = await reserveControlPlaneWrite(db, { ...identity, fingerprint: operationFingerprint(req.method, req.path) });
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
      void settleControlPlaneWrite(db, { ...identity, reservationId, failure }).then(async (incident) => {
        if (incident?.created && notify) await notify(incident);
      }).catch(() => {
        // The durable reservation stays charged if settlement is unavailable.
        // Never log the exception: drivers can include SQL values and secrets.
        logger.warn({ runId: identity.runId }, "Control-plane write settlement unavailable");
      }).finally(() => end(...args));
      return res;
    }) as typeof res.end;
    await validateAgentWriteRun(db, identity);
    next();
  };
}
