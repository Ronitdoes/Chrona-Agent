export type Clock = {
  instant: Date;
  tz: string;
  iso: string;
  human: string;
};

function assertTimeZone(tz: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw new Error(`Unknown timezone: ${tz}`);
  }
}

function parseNowOverride(raw: string): Date {
  const parsed = new Date(raw);

  if (Number.isNaN(parsed.getTime())) {
    throw new Error("NOW_OVERRIDE must be a valid date");
  }

  return parsed;
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