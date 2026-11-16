import { readRichAnswer } from "./answer-blocks";
import { z } from "zod";
import { dateFrom } from "./clock";
import type { Turn } from "./store/schema";

export type HistoryCursor = { ts: Date; id: number };
const cursorSchema = z.strictObject({ ts: z.iso.datetime({ offset: true }), id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) });

export function encodeCursor(turn: Pick<Turn, "id" | "ts">): string {
  return Buffer.from(JSON.stringify({ ts: turn.ts.toISOString(), id: turn.id })).toString("base64url");
}

export function decodeCursor(raw: string): HistoryCursor {
  if (raw.length > 512 || !/^[\w-]+$/.test(raw)) throw new Error("Invalid history cursor");
  try {
    const parsed = cursorSchema.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    return { id: parsed.id, ts: dateFrom(parsed.ts) };
  } catch { throw new Error("Invalid history cursor"); }
}

export type HistoryTurn = Pick<Turn, "id" | "role" | "content" | "tz"> & { ts: string; answerUi?: import("./answer-blocks").RichAnswerV1 };
export type HistorySession = { id: string; title: string; lastTs: string; days: { date: string; turns: HistoryTurn[] }[] };

/** Groups a page into sessions, then local calendar days; no clock reads or I/O. */
export function groupHistory(turns: readonly Turn[], tz: string): HistorySession[] {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const sessions = new Map<string, { rows: Turn[]; days: Map<string, HistoryTurn[]> }>();
  for (const turn of [...turns].sort((a, b) => a.ts.getTime() - b.ts.getTime() || a.id - b.id)) {
    if (!sessions.has(turn.sessionId)) sessions.set(turn.sessionId, { rows: [], days: new Map() });
    const session = sessions.get(turn.sessionId)!;
    session.rows.push(turn);
    const parts = Object.fromEntries(formatter.formatToParts(turn.ts).map(({ type, value }) => [type, value]));
    const day = `${parts.year}-${parts.month}-${parts.day}`;
    if (!session.days.has(day)) session.days.set(day, []);
    session.days.get(day)!.push({ id: turn.id, role: turn.role, content: turn.content, ts: turn.ts.toISOString(), tz: turn.tz, answerUi: readRichAnswer(turn.answerUi) });
  }
  return [...sessions].map(([id, { rows, days }]) => ({
    id, title: (rows.find((turn) => turn.role === "user")?.content ?? rows[0].content).replace(/\s+/g, " ").trim().slice(0, 80),
    lastTs: rows.at(-1)!.ts.toISOString(),
    days: [...days].map(([date, turns]) => ({ date, turns })),
  })).sort((a, b) => b.lastTs.localeCompare(a.lastTs) || a.id.localeCompare(b.id));
}
