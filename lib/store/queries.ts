import { and, asc, desc, eq, getTableColumns, gte, inArray, lt, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { now, type Clock } from "../clock";
import type { HistoryCursor } from "../history";
import * as schema from "./schema";
import { claims, curations, memory, threads, turns } from "./schema";
import type { SearchResult } from "../tools/results";

export type StoreDatabase = NodePgDatabase<typeof schema> | PgliteDatabase<typeof schema>;
export type SaveTurnInput = Pick<typeof turns.$inferInsert, "userId" | "sessionId" | "role" | "content"> & {
  ts?: Date;
  tz?: string;
  curation?: { userTurnId: number; evidence: SearchResult[] };
};

function scopedUser(userId: string): string {
  if (!userId.trim()) throw new Error("A userId is required for every store query");
  return userId;
}

function boundedLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new RangeError("Store query limit must be an integer between 1 and 200");
  }
  return limit;
}

export function createQueries(db: StoreDatabase, clock: () => Clock = now) {
  return {
    async historyFor(userId: string, options: { sessionId?: string; before?: HistoryCursor; limit?: number } = {}) {
      const limit = boundedLimit(options.limit ?? 100);
      const cursor = options.before;
      return db.select().from(turns).where(and(
        eq(turns.userId, scopedUser(userId)),
        options.sessionId ? eq(turns.sessionId, options.sessionId) : undefined,
        cursor ? or(lt(turns.ts, cursor.ts), and(eq(turns.ts, cursor.ts), lt(turns.id, cursor.id))) : undefined,
      )).orderBy(desc(turns.ts), desc(turns.id)).limit(limit + 1);
    },

    async saveTurn(input: SaveTurnInput) {
      scopedUser(input.userId);
      const current = input.ts ? undefined : clock();
      const { curation, ...fields } = input;
      const values = {
        ...fields,
        ts: input.ts ?? current!.instant,
        tz: input.tz ?? current?.tz,
      };
      if (!curation) return (await db.insert(turns).values(values).returning())[0];
      return db.transaction(async (tx) => {
        const [user] = await tx.select().from(turns).where(and(
          eq(turns.id, curation.userTurnId), eq(turns.userId, input.userId),
          eq(turns.sessionId, input.sessionId), eq(turns.role, "user"),
        ));
        if (input.role !== "assistant" || !user) throw new Error("Curation requires an owned conversation pair");
        const [turn] = await tx.insert(turns).values(values).returning();
        await tx.insert(curations).values({ turnId: turn.id, userTurnId: user.id, userId: input.userId, evidence: curation.evidence });
        return turn;
      });
    },

    async turnsInRange(userId: string, startUtc: Date, endUtc: Date, limit = 100) {
      scopedUser(userId);
      if (!(startUtc.getTime() < endUtc.getTime())) {
        throw new RangeError("Recall range must have valid start < end instants");
      }
      return db.select().from(turns).where(and(
        eq(turns.userId, userId), gte(turns.ts, startUtc), lt(turns.ts, endUtc),
      )).orderBy(asc(turns.ts), asc(turns.id)).limit(boundedLimit(limit));
    },

    async searchTurns(userId: string, text: string, reference: Date, limit = 20) {
      scopedUser(userId);
      boundedLimit(limit);
      if (!text.trim()) return [];
      const query = sql`websearch_to_tsquery('english', ${text})`;
      // Boost comparable matches by recency; the reference is injected, never DB now().
      const ageDays = sql`greatest(0, extract(epoch from (${reference.toISOString()}::timestamptz - ${turns.ts})) / 86400.0)`;
      const rank = sql`ts_rank_cd(${turns.tsv}, ${query}) * (1 + 1 / (1 + ${ageDays} / 30.0))`;
      return db.select().from(turns).where(and(
        eq(turns.userId, userId), sql`${turns.tsv} @@ ${query}`,
      )).orderBy(desc(rank), desc(turns.ts), desc(turns.id)).limit(limit);
    },

    async claimsForTurns(userId: string, turnIds: number[]) {
      scopedUser(userId);
      if (!turnIds.length) return [];
      return db.select(getTableColumns(claims)).from(claims).innerJoin(turns, and(
        eq(claims.turnId, turns.id), eq(turns.userId, userId),
      )).where(and(eq(claims.userId, userId), inArray(claims.turnId, turnIds)))
        .orderBy(asc(claims.asOf), asc(claims.id));
    },

    async memoryFor(userId: string) {
      return db.select().from(memory).where(eq(memory.userId, scopedUser(userId)))
        .orderBy(asc(memory.key));
    },

    async threadsFor(userId: string, limit = 20) {
      return db.select().from(threads).where(eq(threads.userId, scopedUser(userId)))
        .orderBy(desc(threads.lastTs), desc(threads.id)).limit(boundedLimit(limit));
    },
  };
}
