import { and, asc, desc, eq, isNull, sql, type AnyColumn } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { dateFrom } from "../clock";
import { keyOf, memoryKey, sameValue, supportingSources, validateExtraction } from "../curator/schema";
import { revalidateClaim } from "../recall/diff";
import { normalizePublishedDate } from "../tools/results";
import { USER_MEMORY_LOCK, type StoreDatabase } from "./queries";
import { claims, curations, memory, threads, turns } from "./schema";

const normalized = (column: AnyColumn) => sql`lower(regexp_replace(btrim(${column}), '[[:space:]]+', ' ', 'g'))`;
function requireUser(userId: string) {
  if (!userId.trim()) throw new Error("A userId is required for every store query");
}
const userTurns = alias(turns, "curation_user_turn");

export function createCurationQueries(db: StoreDatabase) {
  return {
    async pendingCurations(userId: string, limit = 2, currentTurnId?: number) {
      requireUser(userId);
      if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new RangeError("Invalid curation limit");
      const pending = () => db.select({ user: userTurns, assistant: turns, evidence: curations.evidence })
        .from(curations).innerJoin(turns, and(
          eq(curations.turnId, turns.id), eq(turns.userId, userId), eq(turns.role, "assistant"),
        )).innerJoin(userTurns, and(
          eq(curations.userTurnId, userTurns.id), eq(userTurns.userId, userId), eq(userTurns.role, "user"),
          eq(userTurns.sessionId, turns.sessionId),
        ));
      const scope = and(eq(curations.userId, userId), isNull(curations.completed));
      const rows = await pending().where(scope).orderBy(asc(turns.ts), asc(turns.id)).limit(limit);
      // Always give this answer a slot even if earlier invalid outputs keep failing.
      if (currentTurnId !== undefined && !rows.some((row) => row.assistant.id === currentTurnId)) {
        const [current] = await pending().where(and(scope, eq(curations.turnId, currentTurnId))).limit(1);
        if (current) return [...rows.slice(0, limit - 1), current];
      }
      return rows;
    },

    async applyCuration(userId: string, turnId: number, output: unknown, completedAt: Date): Promise<boolean> {
      requireUser(userId);
      return db.transaction(async (tx) => {
        // Serialize merges across sessions/instances; no network work happens under this lock.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${USER_MEMORY_LOCK}, hashtext(${userId}))`);
        const [job] = await tx.select().from(curations)
          .where(and(eq(curations.userId, userId), eq(curations.turnId, turnId), isNull(curations.completed)));
        if (!job) return false;
        const [assistant] = await tx.select().from(turns).where(and(eq(turns.id, turnId), eq(turns.userId, userId), eq(turns.role, "assistant")));
        const [user] = await tx.select().from(turns).where(and(eq(turns.id, job.userTurnId), eq(turns.userId, userId), eq(turns.role, "user")));
        if (!assistant || !user || assistant.sessionId !== user.sessionId) throw new Error("Invalid curation owner");
        const extraction = validateExtraction(output, { user, assistant, evidence: job.evidence });
        if (!extraction) throw new Error("Invalid curation output");

        for (const claim of extraction.claims) {
          const existing = await tx.select().from(claims).where(and(
            eq(claims.userId, userId), eq(normalized(claims.subject), keyOf(claim.subject)),
            eq(normalized(claims.attribute), keyOf(claim.attribute)), isNull(claims.supersededBy),
          ));
          const asOf = dateFrom(claim.asOf);
          // Keep original transcript baselines immutable and avoid stale retries replacing newer facts.
          if (existing.some((old) => sameValue(old.value, claim.value) || old.asOf > asOf)) continue;
          const confirmedChanges = existing.filter((old) => supportingSources(claim, job.evidence).some((source) => {
            const published = normalizePublishedDate(source.published_date);
            return revalidateClaim(old, { text: claim.evidenceQuote, publishedAt: published ? dateFrom(published) : null }, asOf).verdict === "changed";
          }));
          // An unverified conflict must not become a second active version of the fact.
          if (existing.length && confirmedChanges.length !== existing.length) continue;
          const [saved] = await tx.insert(claims).values({
            userId, turnId, subject: claim.subject, attribute: claim.attribute, value: claim.value,
            asOf, sourceUrls: claim.sourceUrls, volatility: claim.volatility,
          }).returning();
          for (const old of confirmedChanges) {
            await tx.update(claims).set({ supersededBy: saved.id }).where(and(eq(claims.id, old.id), eq(claims.userId, userId), isNull(claims.supersededBy)));
          }
        }
        for (const fact of extraction.memory) {
          const canonicalKey = memoryKey(fact.key);
          const [existing] = await tx.select().from(memory).where(and(eq(memory.userId, userId),
            eq(sql`lower(regexp_replace(btrim(${memory.key}), '[[:space:]-]+', '_', 'g'))`, canonicalKey),
          )).orderBy(desc(memory.updatedAt)).limit(1);
          if (existing && (existing.updatedAt > user.ts ||
            (existing.updatedAt.getTime() === user.ts.getTime() && (existing.sourceTurnId ?? 0) > user.id))) continue;
          const key = existing?.key ?? canonicalKey;
          await tx.insert(memory).values({ userId, key, value: fact.value, updatedAt: user.ts, sourceTurnId: user.id })
            .onConflictDoUpdate({ target: [memory.userId, memory.key], set: { value: fact.value, updatedAt: user.ts, sourceTurnId: user.id } });
        }
        for (const topic of extraction.threads) {
          const [existing] = await tx.select().from(threads).where(and(
            eq(threads.userId, userId), eq(normalized(threads.title), keyOf(topic.title)),
          )).orderBy(desc(threads.lastTs), desc(threads.id)).limit(1);
          if (existing) {
            if (existing.lastTs < assistant.ts || (existing.lastTs.getTime() === assistant.ts.getTime() && (existing.sourceTurnId ?? 0) <= assistant.id)) {
              await tx.update(threads).set({ summary: topic.summary, lastTs: assistant.ts, sourceTurnId: assistant.id })
              .where(and(eq(threads.id, existing.id), eq(threads.userId, userId)));
            }
          } else await tx.insert(threads).values({ userId, ...topic, lastTs: assistant.ts, sourceTurnId: assistant.id });
        }
        await tx.update(curations).set({ completed: completedAt }).where(and(eq(curations.userId, userId), eq(curations.turnId, turnId)));
        return true;
      });
    },
  };
}
