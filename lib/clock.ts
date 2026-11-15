import { z } from "zod";

const instantSchema = z.iso.datetime({ offset: true });

// Duration budgets must advance even when NOW_OVERRIDE fixes the calendar clock.
export function monotonicMs(): number {
  return performance.now();
}

export type Clock = {
  instant: Date;
  tz: string;
  iso: string;
  human: string;
};

// Explicit construction for calendar arithmetic and fixtures; never reads the clock.
export function dateFrom(value: string | number): Date {
  return new Date(value);
}

function assertTimeZone(tz: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw new Error(`Unknown timezone: ${tz}`);
  }
}

function parseNowOverride(raw: string): Date {
  if (!instantSchema.safeParse(raw).success) {
    throw new Error("NOW_OVERRIDE must be a valid ISO timestamp with Z or an explicit offset");
  }

  return dateFrom(raw);
}

export function now(tz: string = process.env.DEFAULT_TZ ?? "Asia/Kolkata"): Clock {
  assertTimeZone(tz);

  const override = process.env.NOW_OVERRIDE?.trim();
  const instant = override ? parseNowOverride(override) : new Date();

  const formatted = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    dateStyle: "full",
    timeStyle: "short",
  }).format(instant);

  return {
    instant,
    tz,
    iso: instant.toISOString(),
    human: `${formatted} (${tz})`,
  };
}
