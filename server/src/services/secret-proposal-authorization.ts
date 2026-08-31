import type { Db } from "@paperclipai/db";
import { forbidden, unprocessable } from "../errors.js";
import { accessService } from "./access.js";
import { authorizationDeniedDetails, type AuthorizationActor } from "./authorization.js";

type ResolvableSecretProposal = {
  kind: string;
  targetId: string | null;
};

export async function assertCanResolveProposal(input: {
  db: Db;
  actor: AuthorizationActor;
  companyId: string;
  proposal: ResolvableSecretProposal;
  assertSecretDefinitionAdmin?: () => void;
}) {
  if (input.proposal.kind === "secret") {
    if (!input.assertSecretDefinitionAdmin) {
      throw forbidden("Company admin access required");
    }
    input.assertSecretDefinitionAdmin();
    return;
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
