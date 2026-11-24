import { ISSUE_WRITE_DENIAL_CODES } from "@paperclipai/shared";
import { createHash } from "node:crypto";

export type FailureCategory = "infrastructure" | "transport" | "auth_context" | "policy" | "application";
export type FailureClassification = { category: FailureCategory; rootCause: string; retryable: boolean; owner: "runtime_operator" | "security_operator" | "implementation_owner" };
const transport = new Set(["api_transport_failure","ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "UND_ERR_CONNECT_TIMEOUT"]);
const infrastructure = new Set(["CONNECTION_CLOSED", "CONNECTION_ENDED", "CONNECTION_DESTROYED", "53300", "57P01", "57P02", "57P03", "08006", "40001", "40P01", "ENOSPC", "EMFILE"]);
const policyCodes = new Set<string>(ISSUE_WRITE_DENIAL_CODES);
const context = new Set(["agent_jwt_run_id_mismatch", "cross_issue_influence_run_context_required", "RESPONSIBLE_USER_UNAVAILABLE"]);

/** Never persist error text, request headers, query values, or response bodies. */
export function classifyControlPlaneFailure(input: { status?: number; code?: unknown; error?: unknown }): FailureClassification {
  let code = typeof input.code === "string" ? input.code : "";
  let error = input.error;
  const seen = new Set<unknown>();
  while (error && typeof error === "object" && !seen.has(error) && seen.size < 8) {
    seen.add(error);
    const candidate = error as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === "string" && (transport.has(candidate.code) || infrastructure.has(candidate.code))) code = candidate.code;
    error = candidate.cause;
  }
  if (context.has(code) || input.status === 401) return { category: "auth_context", rootCause: context.has(code) ? code : "authentication_failed", retryable: false, owner: "security_operator" };
  if (input.status === 403 || (input.status === 429 && code === "cross_issue_influence_cap_exceeded")) return { category: "policy", rootCause: policyCodes.has(code) ? code : "policy_denied", retryable: false, owner: "security_operator" };
  if (transport.has(code)) return { category: "transport", rootCause: code, retryable: true, owner: "runtime_operator" };
  if (infrastructure.has(code) || [502, 503, 504].includes(input.status ?? 0)) return { category: "infrastructure", rootCause: infrastructure.has(code) ? code : `http_${input.status}`, retryable: true, owner: "runtime_operator" };
  return { category: "application", rootCause: "application_failure", retryable: false, owner: "implementation_owner" };
}

export function operationFingerprint(method: string, path: string) {
  // Intentionally coarser than payload identity: changing a secret/body cannot
  // reset a failed operation's budget. Query strings and credentials are absent.
  return createHash("sha256").update(`${method.toUpperCase()} ${path.split("?")[0]}`).digest("hex");
}
