import * as chrono from "chrono-node";

export type DateRange = {
  startUtc: Date;
  endUtc: Date;
  label: string;
};

type LocalDate = {
  year: number;
  month: number;
  day: number;
};

type ParsedResult = ReturnType<typeof chrono.parse>[number];

type Candidate = DateRange & { sortIndex: number };

const partsFormatterCache = new Map<string, Intl.DateTimeFormat>();
const shortDateFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  day: "numeric",
  month: "short",
  year: "numeric",
});
const weekdayFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  weekday: "long",
});

function getPartsFormatter(tz: string): Intl.DateTimeFormat {
  const cached = partsFormatterCache.get(tz);
  if (cached) return cached;

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  partsFormatterCache.set(tz, formatter);
  return formatter;
}

function assertTimeZone(tz: string): void {
  try {
    getPartsFormatter(tz);
  } catch {
    throw new Error(`Unknown timezone: ${tz}`);
  }
}

type ZonedParts = {
  day: LocalDate;
  hour: number;
  minute: number;
  second: number;
};

function getZonedParts(instant: Date, tz: string): ZonedParts {
  const values: Record<string, string> = {};

  for (const part of getPartsFormatter(tz).formatToParts(instant)) {
    if (part.type !== "literal") values[part.type] = part.value;
  }

  return {
    day: {
      year: Number(values.year),
      month: Number(values.month),
      day: Number(values.day),
    },
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

function getLocalDate(instant: Date, tz: string): LocalDate {
  return getZonedParts(instant, tz).day;
}

function getOffsetMs(instant: Date, tz: string): number {
  const truncated = new Date(Math.floor(instant.getTime() / 1000) * 1000);
  const local = getZonedParts(truncated, tz);
  const localAsUtc = Date.UTC(
    local.day.year,
    local.day.month - 1,
    local.day.day,
    local.hour,
    local.minute,
    local.second,
  );

  return localAsUtc - truncated.getTime();
}

function toUtcDate(day: LocalDate): Date {
  return new Date(Date.UTC(day.year, day.month - 1, day.day));
}

function fromUtcDate(date: Date): LocalDate {
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function addDays(day: LocalDate, amount: number): LocalDate {
  const date = toUtcDate(day);
  date.setUTCDate(date.getUTCDate() + amount);
  return fromUtcDate(date);
}

function compareDays(left: LocalDate, right: LocalDate): number {
  return (
    Date.UTC(left.year, left.month - 1, left.day) -
    Date.UTC(right.year, right.month - 1, right.day)
  );
}

function zonedDateTimeToUtc(day: LocalDate, tz: string): Date {
  const naive = Date.UTC(day.year, day.month - 1, day.day, 0, 0, 0);
  let utcMs = naive;

  for (let attempt = 0; attempt < 4; attempt++) {
    const next = naive - getOffsetMs(new Date(utcMs), tz);
    if (next === utcMs) break;
    utcMs = next;
  }

  return new Date(utcMs);
}

function localDayRange(day: LocalDate, tz: string, label: string): DateRange {
  return {
    startUtc: zonedDateTimeToUtc(day, tz),
    endUtc: zonedDateTimeToUtc(addDays(day, 1), tz),
    label,
  };
}

function formatShortDate(day: LocalDate): string {
  return shortDateFormatter.format(toUtcDate(day));
}

function formatWeekdayName(day: LocalDate): string {
  return weekdayFormatter.format(toUtcDate(day));
}

function formatWeekdayDate(day: LocalDate): string {
  return `${formatWeekdayName(day)} ${formatShortDate(day)}`;
}

function formatRangeLabel(start: LocalDate, endExclusive: LocalDate): string {
  const last = addDays(endExclusive, -1);

  if (start.month === last.month && start.year === last.year) {
    return `${start.day}–${formatShortDate(last)}`;
  }

  return `${formatShortDate(start)} – ${formatShortDate(last)}`;
}

function startOfWeek(day: LocalDate): LocalDate {
  const weekday = toUtcDate(day).getUTCDay();
  const daysSinceMonday = (weekday + 6) % 7;
  return addDays(day, -daysSinceMonday);
}

function lastWeekRange(day: LocalDate, tz: string): DateRange {
  const currentWeekStart = startOfWeek(day);
  const start = addDays(currentWeekStart, -7);
  const end = currentWeekStart;

  return {
    startUtc: zonedDateTimeToUtc(start, tz),
    endUtc: zonedDateTimeToUtc(end, tz),
    label: formatRangeLabel(start, end),
  };
}

function isLastWeek(result: ParsedResult): boolean {
  return /\blast\s+week\b/i.test(result.text);
}

function labelForResult(result: ParsedResult, day: LocalDate): string {
  const text = result.text.toLowerCase();

  if (/\byesterday\b/.test(text)) return `Yesterday ${formatShortDate(day)}`;
  if (/\btoday\b/.test(text)) return `Today ${formatShortDate(day)}`;
  if (result.start.isCertain("weekday")) return formatWeekdayDate(day);

  return formatShortDate(day);
}

function applyPastBias(
  day: LocalDate,
  result: ParsedResult,
  today: LocalDate,
): LocalDate {
  const text = result.text.toLowerCase();

  if (result.start.isCertain("weekday")) {
    if (/\blast\b/.test(text)) {
      let adjusted = day;

      while (compareDays(adjusted, today) >= 0) {
        adjusted = addDays(adjusted, -7);
      }

      return adjusted;
    }

    if (compareDays(day, today) > 0) return addDays(day, -7);
    return day;
  }

  if (!result.start.isCertain("year") && compareDays(day, today) > 0) {
    return { ...day, year: day.year - 1 };
  }

  return day;
}

function previousMonth(day: LocalDate, targetDay: number): LocalDate {
  const firstOfPreviousMonth = new Date(Date.UTC(day.year, day.month - 2, 1));
  const year = firstOfPreviousMonth.getUTCFullYear();
  const month = firstOfPreviousMonth.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();

  return { year, month, day: Math.min(targetDay, lastDay) };
}

function overlaps(
  index: number,
  length: number,
  results: ParsedResult[],
): boolean {
  return results.some(
    (result) =>
      index < result.index + result.text.length &&
      index + length > result.index,
  );
}

function addOrdinalFallbacks(
  text: string,
  today: LocalDate,
  tz: string,
  results: ParsedResult[],
  candidates: Candidate[],
): void {
  const ordinalPattern =
    /\b(?:on\s+)?(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\b/gi;

  for (const match of text.matchAll(ordinalPattern)) {
    const index = match.index ?? 0;
    const phrase = match[0];
    const targetDay = Number(match[1]);

    if (targetDay < 1 || targetDay > 31) continue;
    if (overlaps(index, phrase.length, results)) continue;

    let day: LocalDate = { year: today.year, month: today.month, day: targetDay };
    if (compareDays(day, today) > 0) {
      day = previousMonth(today, targetDay);
    }

    candidates.push({
      ...localDayRange(day, tz, formatShortDate(day)),
      sortIndex: index,
    });
  }
}

export function resolveDates(
  text: string,
  nowInstant: Date,
  tz: string,
): DateRange[] {
  assertTimeZone(tz);

  const today = getLocalDate(nowInstant, tz);
  const offsetMinutes = Math.round(getOffsetMs(nowInstant, tz) / 60_000);
  const results = chrono.parse(text, {
    instant: nowInstant,
    timezone: offsetMinutes,
  });

  const candidates: Candidate[] = [];

  for (const result of results) {
    if (isLastWeek(result)) {
      candidates.push({
        ...lastWeekRange(today, tz),
        sortIndex: result.index,
      });
      continue;
    }

    const year = result.start.get("year");
    const month = result.start.get("month");
    const day = result.start.get("day");

    if (year === null || month === null || day === null) continue;

    const resolved = applyPastBias({ year, month, day }, result, today);
    candidates.push({
      ...localDayRange(resolved, tz, labelForResult(result, resolved)),
      sortIndex: result.index,
    });
  }

  addOrdinalFallbacks(text, today, tz, results, candidates);

  const seen = new Set<string>();

  return candidates
    .sort((left, right) => left.sortIndex - right.sortIndex)
    .filter((candidate) => {
      const key = `${candidate.startUtc.toISOString()}|${candidate.endUtc.toISOString()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((candidate) => ({
      startUtc: candidate.startUtc,
      endUtc: candidate.endUtc,
      label: candidate.label,
    }));
}