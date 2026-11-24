import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveDefaultStorageDir } from "@paperclipai/shared/home-paths";

export type ControlPlaneIntent = { id: string; runId: string; kind: "storage" | "transport"; reservationId?: string; status?: number };
export function controlPlaneIntentDirectory() { return path.join(resolveDefaultStorageDir(), "control-plane-intents"); }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Host-owned durable slots; deliberately one budget per run/lane, not URL.
 * Only identity and fixed failure metadata reach disk. Never replay mutations. */
export async function reservePersistentControlPlaneWrite(runId: string, kind: ControlPlaneIntent["kind"], directory = controlPlaneIntentDirectory(), reservationId?: string) {
  if (!uuid.test(runId) || (reservationId && !uuid.test(reservationId))) throw new Error("control_plane_invalid_identity");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await fs.readdir(directory)).length >= 4096) throw new Error("control_plane_intent_capacity_exhausted");
  for (let slot = 0; slot < 2; slot++) {
    const filename = path.join(directory, `${runId.toLowerCase()}-${kind}-${slot}.json`);
    const temporary = path.join(directory, `${randomUUID()}.pending`);
    const intent: ControlPlaneIntent = { id: randomUUID(), runId, kind, ...(reservationId ? { reservationId } : {}) };
    const file = await fs.open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(intent)); await file.sync(); } finally { await file.close(); }
    try { await fs.link(temporary, filename); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw new Error("control_plane_intent_storage_unavailable");
    } finally { await fs.unlink(temporary); }
    // Persist directory entry as well as contents before admitting the write.
    const dir = await fs.open(directory, "r"); try { await dir.sync(); } finally { await dir.close(); }
    return {
      intent, filename,
      async succeed() { await fs.unlink(filename); },
      async fail(status?: number) {
        if (status !== undefined && Number.isInteger(status) && status >= 400 && status <= 599) intent.status = status;
        const failed = await fs.open(`${filename}.failed`, "w", 0o600);
        try { await failed.writeFile(JSON.stringify(intent)); await failed.sync(); } finally { await failed.close(); }
      },
    };
  }
  throw new Error("control_plane_write_budget_exhausted");
}

/** Recovery only exposes a schema allowlist. Corrupt/partial files remain charged. */
export async function readControlPlaneIntents(directory = controlPlaneIntentDirectory()) {
  const names = await fs.readdir(directory).catch(() => []);
  const intents: Array<{ filename: string; intent: ControlPlaneIntent }> = [];
  for (const name of names.filter((name) => name.endsWith(".json")).slice(0, 4096)) {
    const filename = path.join(directory, name);
    try {
      const stat = await fs.stat(filename);
      // In-flight/crash reservations remain charged. Wait beyond bridge timeout.
      const failed = await fs.readFile(`${filename}.failed`, "utf8").catch(() => null);
      if (!failed && Date.now() - stat.mtimeMs < 300_000) continue;
      const value = JSON.parse(failed ?? await fs.readFile(filename, "utf8"));
      if (!uuid.test(value.id) || !uuid.test(value.runId) || !["storage", "transport"].includes(value.kind)) continue;
      intents.push({ filename, intent: { id: value.id, runId: value.runId, kind: value.kind,
        ...(uuid.test(value.reservationId) ? { reservationId: value.reservationId } : {}),
        ...(Number.isInteger(value.status) && value.status >= 400 && value.status <= 599 ? { status: value.status } : {}),
      } });
    } catch { /* Fail closed; no unvalidated data is replayable. */ }
  }
  return intents;
}
