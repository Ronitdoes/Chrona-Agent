import type { Clock } from "../clock";
import type { Store } from "../store";
import type { Claim, Memory, Thread, Turn } from "../store/schema";
import { resolveDates, type DateRange } from "./temporal";

export type RecallStore = Pick<Store, "turnsInRange" | "searchTurns" | "claimsForTurns" | "memoryFor" | "threadsFor">;
export type Recall = {
  turns: Turn[];
  claims: Claim[];
  memory: Memory[];
  threads: Thread[];
  resolvedRanges: DateRange[];
  missingRanges: DateRange[];
  matchedBy: "date" | "keyword" | "none";
  notFound: boolean;
  truncated: boolean;
};

const stopWords = new Set(`a an the i we you me my our your it is was are were be been did do does what which who when where how
  on at in from to of for with and or about any them they those these that this have has had since asked ask told tell said say
  last yesterday today monday tuesday wednesday thursday friday saturday sunday january february march april may june july august
  september october november december week month year ago still changed changes latest current correct answer previously`.split(/\s+/));

export function keywordQuery(text: string): string {
  const words = text.match(/[\p{L}\p{N}]+/gu) ?? [];
  const keywords = [...new Set(words.filter((word) =>
    word.length > 1 && !stopWords.has(word.toLowerCase()) && !/^\d+(?:st|nd|rd|th)?$/i.test(word),
  ))].slice(0, 12);
  return keywords.map((word) => `"${word}"`).join(" OR ");
}

function turnGroups(turns: Turn[]): Turn[][] {
  const groups: Turn[][] = [];
  const pending = new Map<string, Turn[]>();
  const priorities = new Map(turns.map((turn, index) => [turn.id, index]));
  for (const turn of [...turns].sort((a, b) => a.ts.getTime() - b.ts.getTime() || a.id - b.id)) {
    const previous = pending.get(turn.sessionId);
    if (turn.role === "assistant" && previous?.length === 1 && previous[0].role === "user") {
      previous.push(turn);
      pending.delete(turn.sessionId);
    } else {
      const group = [turn];
      groups.push(group);
      if (turn.role === "user") pending.set(turn.sessionId, group);
      else pending.delete(turn.sessionId);
    }
  }
  return groups.sort((a, b) => Math.min(...a.map((turn) => priorities.get(turn.id)!)) - Math.min(...b.map((turn) => priorities.get(turn.id)!)));
}

/** Keep complete fetched user/assistant pairs, with no lossy transcript rewriting. */
export function capRecall(input: Pick<Recall, "turns" | "claims" | "memory" | "threads">, maxBytes: number) {
  let remaining = maxBytes;
  let truncated = false;
  const take = <T>(value: T, display: unknown = value): boolean => {
    const size = Buffer.byteLength(JSON.stringify(display), "utf8") + 1;
    if (size > remaining) { truncated = true; return false; }
    remaining -= size;
    return true;
  };
  const turns = turnGroups(input.turns).filter((group) => take(group, group.map((turn) => ({
    id: turn.id, sessionId: turn.sessionId, role: turn.role, content: turn.content, ts: turn.ts, tz: turn.tz,
  })))).flat();
  turns.sort((a, b) => a.ts.getTime() - b.ts.getTime() || a.id - b.id);
  const turnIds = new Set(turns.map((turn) => turn.id));
  const claims = input.claims.filter((claim) => claim.turnId !== null && turnIds.has(claim.turnId) && take(claim));
  const memory = input.memory.filter((item) => take(item));
  const threads = input.threads.filter((thread) => take(thread));
  return { turns, claims, memory, threads, truncated };
}

export async function retrieve(
  { userId, text, now, maxBytes = 6000 }: { userId: string; text: string; now: Clock; maxBytes?: number },
  dependencies: { store?: RecallStore } = {},
): Promise<Recall> {
  if (!userId.trim()) throw new Error("Recall requires a userId");
  if (!Number.isInteger(maxBytes) || maxBytes < 512) throw new Error("Recall budget must be at least 512 bytes");
  const store = dependencies.store ?? await (await import("../store")).getStore();
  const resolvedRanges = resolveDates(text, now.instant, now.tz);
  const lookup = async () => {
    const dated = await Promise.all(resolvedRanges.map((range) => store.turnsInRange(userId, range.startUtc, range.endUtc)));
    const missingRanges = resolvedRanges.filter((_, index) => dated[index].length === 0);
    let turns = [...new Map(dated.flat().map((turn) => [turn.id, turn])).values()];
    let matchedBy: Recall["matchedBy"] = turns.length ? "date" : "none";
    if (!turns.length) {
      const query = keywordQuery(text);
      turns = query ? await store.searchTurns(userId, query, now.instant) : [];
      if (turns.length) matchedBy = "keyword";
    }
    // Defense in depth at the assembly boundary, in addition to SQL scoping.
    turns = turns.filter((turn) => turn.userId === userId);
    if (matchedBy === "date") turns.sort((a, b) => a.ts.getTime() - b.ts.getTime() || a.id - b.id);
    const claims = turns.length ? await store.claimsForTurns(userId, turns.map((turn) => turn.id)) : [];
    return { turns, claims, missingRanges, matchedBy };
  };
  const [matched, memory, threads] = await Promise.all([
    lookup(), store.memoryFor(userId), store.threadsFor(userId),
  ]);
  const capped = capRecall({
    turns: matched.turns,
    claims: matched.claims.filter((claim) => claim.userId === userId),
    memory: memory.filter((item) => item.userId === userId),
    threads: threads.filter((thread) => thread.userId === userId),
  }, maxBytes);
  return {
    ...capped, resolvedRanges, missingRanges: matched.missingRanges,
    matchedBy: matched.turns.length ? matched.matchedBy : "none", notFound: !matched.turns.length,
  };
}
