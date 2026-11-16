import { and, asc, desc, eq, gt, gte, inArray, lt, notExists, or, sql } from "drizzle-orm";
import type { HistoryCursor } from "../history";
import type { StoreDatabase } from "./queries";
import { recallReferences, turns } from "./schema";

export type HistorySearch = {
  query: string; before: HistoryCursor; sessionId?: string;
  ranges: { startUtc: Date; endUtc: Date }[]; limit: number;
};
function owner(userId: string): string {
  if (!userId.trim()) throw new Error("History requires a userId");
  return userId;
}
function before(cursor: HistoryCursor) {
  if (!Number.isFinite(cursor.ts.getTime()) || !Number.isSafeInteger(cursor.id) || cursor.id < 1) throw new Error("Invalid history boundary");
  return or(lt(turns.ts, cursor.ts), and(eq(turns.ts, cursor.ts), lt(turns.id, cursor.id)));
}

export function createRecallQueries(db: StoreDatabase) {
  return {
    async searchUserHistory(userId: string, options: HistorySearch) {
      if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 200) throw new Error("Invalid history page limit");
      for (const range of options.ranges) if (!(range.startUtc.getTime() < range.endUtc.getTime())) throw new Error("Invalid history range");
      return db.select().from(turns).where(and(
        eq(turns.userId, owner(userId)), eq(turns.role, "user"), before(options.before),
        notExists(db.select({ id: recallReferences.requestTurnId }).from(recallReferences).where(and(eq(recallReferences.requestTurnId, turns.id), eq(recallReferences.historyOnly, true)))),
        options.sessionId ? eq(turns.sessionId, options.sessionId) : undefined,
        options.query ? sql`${turns.tsv} @@ websearch_to_tsquery('english', ${options.query})` : undefined,
        options.ranges.length ? or(...options.ranges.map(range => and(gte(turns.ts, range.startUtc), lt(turns.ts, range.endUtc)))) : undefined,
      )).orderBy(desc(turns.ts), desc(turns.id)).limit(options.limit + 1);
    },
    async historySources(userId: string, ids: number[], boundary: HistoryCursor) {
      if (ids.length > 1000 || ids.some(id => !Number.isSafeInteger(id) || id < 1)) throw new Error("Invalid history references");
      owner(userId);
      if (!ids.length) return [];
      return db.select().from(turns).where(and(eq(turns.userId, userId), eq(turns.role, "user"), inArray(turns.id, ids), before(boundary)))
        .orderBy(asc(turns.ts), asc(turns.id));
    },
    async historyContext(userId: string, id: number, boundary: HistoryCursor) {
      const [anchor] = await db.select().from(turns).where(and(eq(turns.userId, owner(userId)), eq(turns.id, id), before(boundary)));
      if (!anchor) return [];
      const scope = and(eq(turns.userId, userId), eq(turns.sessionId, anchor.sessionId), before(boundary));
      const [previous, next] = await Promise.all([
        db.select().from(turns).where(and(scope, or(lt(turns.ts, anchor.ts), and(eq(turns.ts, anchor.ts), lt(turns.id, id)))))
          .orderBy(desc(turns.ts), desc(turns.id)).limit(2),
        db.select().from(turns).where(and(scope, or(gt(turns.ts, anchor.ts), and(eq(turns.ts, anchor.ts), gt(turns.id, id)))))
          .orderBy(asc(turns.ts), asc(turns.id)).limit(1),
      ]);
      return [...previous.reverse(), anchor, ...next];
    },
    async previousRecall(userId: string, sessionId: string, boundary: HistoryCursor) {
      const [answer] = await db.select().from(turns).where(and(eq(turns.userId, owner(userId)), eq(turns.sessionId, sessionId),
        eq(turns.role, "assistant"), before(boundary))).orderBy(desc(turns.ts), desc(turns.id)).limit(1);
      if (!answer) return null;
      const [reference] = await db.select().from(recallReferences).where(and(eq(recallReferences.userId, userId), eq(recallReferences.answerTurnId, answer.id)));
      return reference ?? null;
    },
  };
}
