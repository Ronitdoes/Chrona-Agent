import { and, asc, desc, eq, getTableColumns, gte, inArray, lt, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { now, type Clock } from "../clock";
import type { HistoryCursor } from "../history";
import * as schema from "./schema";
import { claims, curations, memory, threads, turns, recallReferences } from "./schema";
import type { SearchResult } from "../tools/results";
import { collectionContains, collectionSchema, type RecallCollection } from "../recall/collection";

export type StoreDatabase = NodePgDatabase<typeof schema>;
export const USER_MEMORY_LOCK = 781424;
export type SaveTurnInput = Pick<typeof turns.$inferInsert, "userId" | "sessionId" | "role" | "content"> & {
  ts?: Date;
  tz?: string;
  curation?: { userTurnId: number; evidence: SearchResult[] };
  recall?: { userTurnId: number; sourceTurnIds: number[]; historyOnly?: boolean; collection?: RecallCollection };
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
    async deleteConversation(userId: string, sessionId: string): Promise<boolean> {
      scopedUser(userId);
      if (!sessionId.trim()) throw new Error("A sessionId is required");
      return db.transaction(async tx => {
        // Share the curator's lock: a delayed extraction cannot recreate notes
        // after the conversation and its pending extraction jobs are removed.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${USER_MEMORY_LOCK}, hashtext(${userId}))`);
        const owned = await tx.select({ id: turns.id }).from(turns).where(and(eq(turns.userId, userId), eq(turns.sessionId, sessionId)));
        if (!owned.length) return false;
        const ids = owned.map(turn => turn.id);
        const linked = await tx.select({ id: claims.id }).from(claims).where(and(eq(claims.userId, userId), inArray(claims.turnId, ids)));
        if (linked.length) await tx.update(claims).set({ supersededBy: null }).where(and(eq(claims.userId, userId), inArray(claims.supersededBy, linked.map(claim => claim.id))));
        await tx.delete(claims).where(and(eq(claims.userId, userId), inArray(claims.turnId, ids)));
        await tx.delete(memory).where(and(eq(memory.userId, userId), inArray(memory.sourceTurnId, ids)));
        await tx.delete(threads).where(and(eq(threads.userId, userId), inArray(threads.sourceTurnId, ids)));
        await tx.delete(curations).where(and(eq(curations.userId, userId), or(inArray(curations.turnId, ids), inArray(curations.userTurnId, ids))));
        await tx.delete(turns).where(and(eq(turns.userId, userId), eq(turns.sessionId, sessionId)));
        return true;
      });
    },

    async userMessagesFor(userId: string, options: {
      ranges?: { startUtc: Date; endUtc: Date }[]; before: HistoryCursor; limit?: number; sessionId?: string;
    }) {
      const limit = boundedLimit(options.limit ?? 200);
      for (const range of options.ranges ?? []) if (!(range.startUtc.getTime() < range.endUtc.getTime())) throw new RangeError("History range must have valid start < end instants");
      return db.select({ id: turns.id, userId: turns.userId, sessionId: turns.sessionId, content: turns.content, ts: turns.ts, tz: turns.tz })
        .from(turns).where(and(
          eq(turns.userId, scopedUser(userId)), eq(turns.role, "user"),
          options.sessionId ? eq(turns.sessionId, options.sessionId) : undefined,
          options.ranges?.length ? or(...options.ranges.map(range => and(gte(turns.ts, range.startUtc), lt(turns.ts, range.endUtc)))) : undefined,
          or(lt(turns.ts, options.before.ts), and(eq(turns.ts, options.before.ts), lt(turns.id, options.before.id))),
        )).orderBy(desc(turns.ts), desc(turns.id)).limit(limit + 1);
    },

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
      const { curation, recall, ...fields } = input;
      const values = {
        ...fields,
        ts: input.ts ?? current!.instant,
        tz: input.tz ?? current?.tz,
      };
      if (!curation && !recall) return (await db.insert(turns).values(values).returning())[0];
      return db.transaction(async (tx) => {
        const userTurnId = curation?.userTurnId ?? recall!.userTurnId;
        const [user] = await tx.select().from(turns).where(and(
          eq(turns.id, userTurnId), eq(turns.userId, input.userId),
          eq(turns.sessionId, input.sessionId), eq(turns.role, "user"),
        ));
        if (input.role !== "assistant" || !user) throw new Error("Curation requires an owned conversation pair");
        if (recall) {
          const ids = [...new Set(recall.sourceTurnIds)];
          if (ids.length > 10 || ids.some(id => !Number.isSafeInteger(id) || id < 1) || recall.userTurnId !== userTurnId) throw new Error("Invalid recall references");
          const sources = ids.length ? await tx.select().from(turns).where(and(eq(turns.userId, input.userId), eq(turns.role, "user"), inArray(turns.id, ids),
            or(lt(turns.ts, user.ts), and(eq(turns.ts, user.ts), lt(turns.id, user.id))),
          )) : [];
          if (sources.length !== ids.length) throw new Error("Recall references must be owned earlier user messages");
          if (recall.collection) {
            const collection = collectionSchema.parse(recall.collection);
            const boundary = Date.parse(collection.before.ts);
            if (boundary > user.ts.getTime() || boundary === user.ts.getTime() && collection.before.id > user.id) throw new Error("Invalid collection boundary");
            const originals = collection.sourceTurnIds.length ? await tx.select().from(turns).where(and(eq(turns.userId, input.userId), eq(turns.role, "user"), inArray(turns.id, collection.sourceTurnIds))) : [];
            if (originals.length !== collection.sourceTurnIds.length || !originals.every(row => collectionContains(row, collection))) throw new Error("Invalid collection sources");
          }
        }
        const [turn] = await tx.insert(turns).values(values).returning();
        if (curation) await tx.insert(curations).values({ turnId: turn.id, userTurnId: user.id, userId: input.userId, evidence: curation.evidence });
        if (recall) await tx.insert(recallReferences).values({ answerTurnId: turn.id, requestTurnId: user.id, userId: input.userId, sourceTurnIds: [...new Set(recall.sourceTurnIds)], historyOnly: recall.historyOnly ?? true, collection: recall.collection ?? null });
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
