import { pgTable, uuid, text, integer, boolean, timestamp, primaryKey, index, doublePrecision } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import type { HeartbeatProgressOutcome } from "@paperclipai/shared";

export const heartbeatProgressState = pgTable("heartbeat_progress_state", {
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").primaryKey().references(() => agents.id, { onDelete: "cascade" }),
  fingerprint: text("fingerprint"),
  generation: integer("generation").notNull().default(0),
  consecutiveNoOps: integer("consecutive_no_ops").notNull().default(0),
  timersSuppressed: boolean("timers_suppressed").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const heartbeatProgressReceipts = pgTable("heartbeat_progress_receipts", {
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  eventKey: text("event_key").notNull(),
  runId: uuid("run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.companyId, t.agentId, t.eventKey] })]);

export const heartbeatProgressOutcomes = pgTable("heartbeat_progress_outcomes", {
  runId: uuid("run_id").primaryKey().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  generation: integer("generation").notNull(),
  outcome: text("outcome").$type<HeartbeatProgressOutcome>().notNull().default("unknown"),
  reason: text("reason").notNull(),
  modelInvoked: boolean("model_invoked").notNull().default(false),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  costUsd: doublePrecision("cost_usd"),
}, t => [index("heartbeat_progress_outcomes_agent_idx").on(t.companyId, t.agentId)]);

export const heartbeatDeliveredTransitions = pgTable("heartbeat_delivered_transitions", {
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  transitionKey: text("transition_key").notNull(),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  runId: uuid("run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
  issueId: uuid("issue_id").notNull(),
  kind: text("kind").$type<"task_completed" | "blocker_resolved">().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.companyId, t.transitionKey] }), index("heartbeat_delivered_transitions_agent_idx").on(t.companyId, t.agentId)]);
