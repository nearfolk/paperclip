import { eq } from "drizzle-orm";
import { companies, type Db } from "@paperclipai/db";
import { forbidden, unprocessable } from "../errors.js";
import { accessService } from "./access.js";
import { authorizationDeniedDetails, type AuthorizationActor } from "./authorization.js";
import { boardAuthService } from "./board-auth.js";

type ResolvableSecretProposal = {
  kind: string;
  targetId: string | null;
};

export async function assertCanResolveProposal(input: {
  db: Db;
  actor: AuthorizationActor;
  companyId: string;
  proposal: ResolvableSecretProposal;
}) {
  const company = await input.db
    .select({ status: companies.status })
    .from(companies)
    .where(eq(companies.id, input.companyId))
    .then((rows) => rows[0] ?? null);
  if (company?.status !== "active") throw forbidden("Company is not active");

  if (input.proposal.kind === "secret") {
    if (input.actor.type !== "board") throw forbidden("Company admin access required");
    if (input.actor.source === "local_implicit") return;

    // Cloud-tenant elevation is attested for each request and has no
    // instance_user_roles row to refresh. All other board actors must discard
    // their authentication-time role and membership snapshot after acquiring
    // the principal authorization lock and re-read the authoritative rows.
    if (input.actor.source === "cloud_tenant") {
      const membership = input.actor.memberships?.find((item) => item.companyId === input.companyId);
      if (
        input.actor.isInstanceAdmin ||
        (membership?.status === "active" && ["owner", "admin"].includes(String(membership.membershipRole)))
      ) return;
      throw forbidden("Company admin access required");
    }

    if (!input.actor.userId) throw forbidden("Company admin access required");
    const access = await boardAuthService(input.db).resolveBoardAccess(input.actor.userId);
    const membership = access.memberships.find((item) => item.companyId === input.companyId);
    if (
      access.isInstanceAdmin ||
      (membership?.status === "active" && ["owner", "admin"].includes(String(membership.membershipRole)))
    ) return;
    throw forbidden("Company admin access required");
  }
  if (input.proposal.kind !== "binding" || !input.proposal.targetId) {
    throw unprocessable("Binding proposal target is missing");
  }
  // Session actors may carry an instance-admin bit computed at authentication
  // time. Governed proposal mutations re-run this check after acquiring the
  // principal authorization lock, so force non-cloud actors to consult the
  // authoritative instance_user_roles row instead of trusting that cached bit.
  // Cloud-tenant elevation is separately attested and is not backed by that
  // table; local implicit board access is handled by its source policy.
  const actor = input.actor.type === "board" && input.actor.source !== "cloud_tenant"
    ? { ...input.actor, isInstanceAdmin: false }
    : input.actor;
  const decision = await accessService(input.db).decide({
    actor,
    action: "agent_config:update",
    resource: {
      type: "agent",
      companyId: input.companyId,
      agentId: input.proposal.targetId,
    },
    scope: { requiresChangeGrant: true },
  });
  if (!decision.allowed) {
    throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
  }
}
