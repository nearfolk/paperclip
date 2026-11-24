import { describe, expect, it } from "vitest";
import { classifyControlPlaneFailure as classify, operationFingerprint } from "../services/control-plane-failures.js";
describe("failure classification", () => {
  it.each([
    [{ error: { cause: { code: "CONNECTION_CLOSED" } } }, "infrastructure", true],
    [{ error: { code: "ECONNRESET" } }, "transport", true],
    [{ status: 403, code: "cross_issue_influence_run_context_required" }, "auth_context", false],
    [{ status: 403, code: "scope_denied" }, "policy", false],
    [{ status: 429, code: "cross_issue_influence_cap_exceeded" }, "policy", false],
    [{ status: 500, error: new Error("private application detail") }, "application", false],
  ])("classifies failures without broad retry", (input, category, retryable) => expect(classify(input as never)).toMatchObject({ category, retryable }));
  it("does not copy arbitrary code, error message, or query secrets", () => {
    expect(JSON.stringify(classify({ code: "credential=secret", error: new Error("credential=secret") }))).not.toContain("secret");
    expect(operationFingerprint("PATCH", "/api/issues/a?secret=one")).toBe(operationFingerprint("PATCH", "/api/issues/a?secret=two"));
  });
});
