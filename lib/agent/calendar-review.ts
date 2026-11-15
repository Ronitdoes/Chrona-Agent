import { calendarContext } from "../calendar-context";
import type { Clock } from "../clock";

const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Review the narrow, contradictory claims that caused the match-today regression. */
export function reviewSportsCalendar(answer: string, request: string, clock?: Clock): string | null {
  const plain = answer.replace(/[*_`]/g, "");
  const oneMatch = /\b(?:vs\.?|versus|v)\b/i.test(request);
  const noMatchToday = [...plain.matchAll(/\bno\b[^.!?\n]{0,120}\bmatch(?:es)?\b[^.!?\n]{0,100}\btoday\b/gi)]
    .some(match => !/\b(?:currently|now|ongoing|remaining|further|more|additional|upcoming|later|at (?:this|the) moment)\b/i.test(match[0]));
  const completedToday = /\bearlier\s+today\b|\b(?:finished|completed|ended|played|took place)\s+(?:earlier\s+)?today\b|\btoday'?s\s+[^.!?\n]{0,80}\b(?:finished|completed|ended)\b/i.test(plain);
  if (oneMatch && noMatchToday && completedToday) {
    return "The answer says no match was played today and also says the same match finished earlier today. A completed match today is still today's match. Say it finished earlier today and is no longer live; do not claim there was no match today.";
  }
  if (!clock) return null;
  const calendar = calendarContext(clock);
  // Bind dates to an explicit 'today' apposition, not unrelated past/future fixtures.
  const todayDate = /\btoday\b\s*(?:is\s+)?[,(:–-]?\s*(?:(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\s*,?\s*)?(?:(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})|([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})|(\d{4})-(\d{2})-(\d{2}))/gi;
  for (const match of plain.matchAll(todayDate)) {
    const monthName = match[3] ?? match[5];
    const month = monthName ? months.indexOf(monthName.slice(0, 3).toLowerCase()) + 1 : Number(match[9]);
    if (!month) continue;
    const day = Number(match[2] ?? match[6] ?? match[10]);
    const year = Number(match[4] ?? match[7] ?? match[8]);
    const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (iso !== calendar.today || match[1] && match[1].toLowerCase() !== calendar.weekday.toLowerCase()) {
      return `The date or weekday attached to today is incorrect. Today is ${calendar.weekday}, ${calendar.todayLabel} (${calendar.today}) in ${calendar.timezone}. Keep venue dates separate and explicitly label any timezone conversion.`;
    }
  }
  return null;
}
