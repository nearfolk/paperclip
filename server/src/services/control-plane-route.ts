import { normalizeIssueIdentifier } from "@paperclipai/shared";
import { and, eq } from "drizzle-orm";
import { issues, type Db } from "@paperclipai/db";
import { operationFingerprint } from "./control-plane-failures.js";

/** Express routes are case insensitive and decode parameters once. Never fold
 * arbitrary resource data (document keys, filenames, etc.) into route literals. */
export function issueWriteRoute(method: string, path: string) {
  if (["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())) return null;
  const match = /^\/(?:api\/)?(?:companies\/([^/]+)\/)?issues(?:\/([^/]+))?(?:\/(.*))?\/?$/i.exec(path.split("?")[0]);
  if (!match) return null;
  const decode = (value: string | undefined) => {
    try { return value ? decodeURIComponent(value) : null; } catch { return null; }
  };
  return { company: decode(match[1]), issue: decode(match[2]) };
}

// PostgreSQL's UUID input also accepts braces, omitted hyphens and hyphens
// after any four digits. The issue router passes these accepted forms through.
export function canonicalIssueUuid(reference: string): string | null {
  const value = reference.startsWith("{") && reference.endsWith("}") ? reference.slice(1, -1) : reference;
  if (!/^[0-9a-f]+(?:-[0-9a-f]+)*$/i.test(value) || value.split("-").some((part) => part.length % 4 !== 0)) return null;
  const hex = value.replaceAll("-", "");
  if (hex.length !== 32) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`.toLowerCase();
}

export async function issueWriteFingerprint(db: Pick<Db, "select">, companyId: string, method: string, path: string) {
  const route = issueWriteRoute(method.replace(/^TRANSPORT /, ""), path);
  if (!route) return operationFingerprint(method, path);
  let resource = "collection";
  if (route.issue) {
    const uuid = canonicalIssueUuid(route.issue);
    const [issue] = await db.select({ id: issues.id }).from(issues).where(and(
      eq(issues.companyId, companyId),
      uuid ? eq(issues.id, uuid) : eq(issues.identifier, normalizeIssueIdentifier(route.issue) ?? route.issue),
    ));
    resource = issue?.id ?? "unresolved";
  }
  // Deliberately aggregate subresources: their case-sensitive data never enters
  // the ledger, and no accepted URL alias can buy another failed attempt.
  return operationFingerprint(method, `/companies/${companyId}/issues/${resource}`);
}
