import { sql, type SQL } from "drizzle-orm";
import type { SearchResult } from "../tools/results";
import {
  bigint, bigserial, check, customType, index, jsonb, pgTable,
  primaryKey, text, timestamp, type AnyPgColumn,
} from "drizzle-orm/pg-core";

const tsvector = customType<{ data: string }>({
  dataType: () => "tsvector",
});

export const turns = pgTable("turns", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  userId: text("user_id").notNull(),
  sessionId: text("session_id").notNull(),
  role: text("role", { enum: ["user", "assistant"] }).notNull(),
  content: text("content").notNull(),
  ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  tz: text("tz"),
  tsv: tsvector("tsv").generatedAlwaysAs(
    (): SQL => sql`to_tsvector('english', ${turns.content})`,
  ),
}, (table) => [
  index("turns_user_ts").on(table.userId, table.ts),
  index("turns_tsv").using("gin", table.tsv),
  check("turns_role_check", sql`${table.role} in ('user', 'assistant')`),
]);

export const claims = pgTable("claims", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  turnId: bigint("turn_id", { mode: "number" }).references(() => turns.id),
  userId: text("user_id").notNull(),
  subject: text("subject").notNull(),
  attribute: text("attribute").notNull(),
  value: text("value").notNull(),
  asOf: timestamp("as_of", { withTimezone: true }).notNull(),
  sourceUrls: jsonb("source_urls").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  volatility: text("volatility", { enum: ["low", "medium", "high"] }).notNull().default("medium"),
  supersededBy: bigint("superseded_by", { mode: "number" }).references((): AnyPgColumn => claims.id),
}, (table) => [
  index("claims_user_subject").on(table.userId, table.subject),
  index("claims_user_turn").on(table.userId, table.turnId),
  check("claims_volatility_check", sql`${table.volatility} in ('low', 'medium', 'high')`),
]);

export const memory = pgTable("memory", {
  userId: text("user_id").notNull(),
  key: text("key").notNull(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  sourceTurnId: bigint("source_turn_id", { mode: "number" }),
}, (table) => [primaryKey({ columns: [table.userId, table.key] })]);

export const threads = pgTable("threads", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  userId: text("user_id").notNull(),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  lastTs: timestamp("last_ts", { withTimezone: true }).notNull(),
  sourceTurnId: bigint("source_turn_id", { mode: "number" }).references(() => turns.id),
}, (table) => [index("threads_user_last_ts").on(table.userId, table.lastTs)]);

export type Turn = typeof turns.$inferSelect;
export type Claim = typeof claims.$inferSelect;
export type Memory = typeof memory.$inferSelect;
export type Thread = typeof threads.$inferSelect;

// Saved atomically with the assistant turn so interrupted background work is retryable.
export const curations = pgTable("curations", {
  turnId: bigint("turn_id", { mode: "number" }).primaryKey().references(() => turns.id, { onDelete: "cascade" }),
  userTurnId: bigint("user_turn_id", { mode: "number" }).notNull().references(() => turns.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  evidence: jsonb("evidence").$type<SearchResult[]>().notNull(),
  completed: timestamp("completed", { withTimezone: true }),
}, (table) => [index("curations_pending").on(table.userId, table.turnId).where(sql`${table.completed} is null`)]);
