import { readRichAnswer } from "./answer-blocks";
import { z } from "zod";
import { dateFrom } from "./clock";
import type { HistorySession } from "./history";
import type { ChatMessage } from "./chat-state";

const turnSchema = z.object({ id: z.number().int(), role: z.enum(["user", "assistant"]), content: z.string(), ts: z.iso.datetime({ offset: true }), tz: z.string().nullable(), answerUi: z.unknown().transform(readRichAnswer).optional() });
export const historyPageSchema = z.object({
  sessions: z.array(z.object({ id: z.uuid(), title: z.string(), lastTs: z.iso.datetime({ offset: true }), days: z.array(z.object({ date: z.iso.date(), turns: z.array(turnSchema) })) })),
  nextCursor: z.string().nullable(), now: z.iso.datetime({ offset: true }), tz: z.string(), activeSessionId: z.uuid(),
});
export type HistoryPage = z.infer<typeof historyPageSchema>;
function dayNumber(iso: string, tz: string): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(dateFrom(iso)).map(part => [part.type, part.value]));
  return dateFrom(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`).getTime() / 86_400_000;
}
export function historyGroups(sessions: HistorySession[], iso: string, tz: string) {
  const groups = ["Today", "Yesterday", "Previous 7 days", "Older"].map(label => ({ label, sessions: [] as HistorySession[] }));
  const today = dayNumber(iso, tz);
  for (const session of [...sessions].sort((a, b) => b.lastTs.localeCompare(a.lastTs))) {
    const age = today - dayNumber(session.lastTs, tz);
    groups[age === 0 ? 0 : age === 1 ? 1 : age >= 2 && age <= 7 ? 2 : 3].sessions.push(session);
  }
  return groups.filter(group => group.sessions.length);
}
export function greeting(iso: string, tz: string): string {
  const hour = Number(new Intl.DateTimeFormat("en", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(dateFrom(iso)));
  return hour >= 5 && hour < 12 ? "Good morning" : hour >= 12 && hour < 18 ? "Good afternoon" : "Good evening";
}
export function sessionMessages(session?: HistorySession): ChatMessage[] {
  return session ? session.days.flatMap(day => day.turns).sort((a, b) => a.ts.localeCompare(b.ts) || a.id - b.id)
    .map(turn => ({ id: `saved-${turn.id}`, role: turn.role, content: turn.content, answerUi: turn.answerUi, sources: turn.answerUi?.sources, state: "complete" })) : [];
}
export function mergeHistory(current: HistorySession[], incoming: HistorySession[]): HistorySession[] {
  const sessions = new Map<string, HistorySession>();
  for (const session of [...current, ...incoming]) {
    const prior = sessions.get(session.id);
    if (!prior) { sessions.set(session.id, structuredClone(session)); continue; }
    const days = new Map<string, HistorySession["days"][number]>();
    for (const day of [...prior.days, ...session.days]) {
      const turns = new Map((days.get(day.date)?.turns ?? []).map(turn => [turn.id, turn]));
      day.turns.forEach(turn => turns.set(turn.id, turn));
      days.set(day.date, { date: day.date, turns: [...turns.values()].sort((a, b) => a.ts.localeCompare(b.ts) || a.id - b.id) });
    }
    const mergedDays = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
    const first = mergedDays.flatMap(day => day.turns).find(turn => turn.role === "user");
    sessions.set(session.id, { id: session.id, title: first?.content.replace(/\s+/g, " ").trim().slice(0, 80) || prior.title,
      lastTs: session.lastTs > prior.lastTs ? session.lastTs : prior.lastTs, days: mergedDays });
  }
  return [...sessions.values()].sort((a, b) => b.lastTs.localeCompare(a.lastTs));
}
