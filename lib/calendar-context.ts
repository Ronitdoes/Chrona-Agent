import { dateFrom, type Clock } from "./clock";

const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const insideUrl = (text: string, offset: number) => /\bhttps?:\/\/[^\s<>]*$/.test(text.slice(0, offset));

function literalDate(year: number, month: number, day: number) {
  const instant = dateFrom(Date.UTC(year, month - 1, day));
  if (instant.getUTCFullYear() !== year || instant.getUTCMonth() !== month - 1 || instant.getUTCDate() !== day) return null;
  return { iso: instant.toISOString().slice(0, 10), label: `${day} ${months[month - 1]} ${year}` };
}

/** Numeric dates with two plausible orders require clarification, not a locale guess. */
export function normalizeDateLiterals(text: string) {
  const ambiguous: { input: string; choices: string[] }[] = [];
  const invalid: string[] = [];
  const dayFirst = /\b(?:DD\s*[/.-]\s*MM\s*[/.-]\s*YYYY|day[- ]first)\b/i.test(text);
  const monthFirst = /\b(?:MM\s*[/.-]\s*DD\s*[/.-]\s*YYYY|month[- ]first)\b/i.test(text);
  const isoChecked = text.replace(/\b(\d{4})-(\d{2})-(\d{2})(?!\d)/g, (input, year: string, month: string, day: string, offset: number) => {
    if (insideUrl(text, offset)) return input;
    if (literalDate(Number(year), Number(month), Number(day))) return input;
    invalid.push(input);
    return " ".repeat(input.length);
  });
  const normalized = isoChecked.replace(/\b(\d{1,2})([/.-])(\d{1,2})\2(\d{4})\b/g, (input, left: string, _separator: string, right: string, rawYear: string, offset: number) => {
    if (insideUrl(isoChecked, offset)) return input;
    const a = Number(left), b = Number(right), year = Number(rawYear);
    const dmy = literalDate(year, b, a);
    const mdy = literalDate(year, a, b);
    const choices = [...new Map([dmy, mdy].filter(date => date !== null).map(date => [date.iso, date])).values()];
    const chosen = dayFirst !== monthFirst ? dayFirst ? dmy : mdy : choices.length === 1 ? choices[0] : null;
    if (chosen) return chosen.iso;
    if (choices.length > 1) ambiguous.push({ input, choices: choices.map(date => date.label) });
    else invalid.push(input);
    return " ".repeat(input.length);
  });
  return { normalized, ambiguous, invalid };
}

/** Derive the user's calendar day from the injected instant, independently of UTC/venue dates. */
export function calendarContext(clock: Clock) {
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: clock.tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(clock.instant).filter(part => part.type !== "literal").map(part => [part.type, part.value]));
  const today = literalDate(Number(values.year), Number(values.month), Number(values.day))!;
  return {
    timezone: clock.tz, today: today.iso, todayLabel: today.label,
    weekday: new Intl.DateTimeFormat("en-GB", { timeZone: clock.tz, weekday: "long" }).format(clock.instant),
    localTime: new Intl.DateTimeFormat("en-GB", { timeZone: clock.tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(clock.instant),
    displayFormat: "D Month YYYY (for example, 15 November 2026)",
  };
}
