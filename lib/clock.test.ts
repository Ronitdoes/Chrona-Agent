import { afterEach, describe, expect, it, vi } from "vitest";
import { now } from "./clock";

const originalOverride = process.env.NOW_OVERRIDE;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  if (originalOverride === undefined) {
    delete process.env.NOW_OVERRIDE;
  } else {
    process.env.NOW_OVERRIDE = originalOverride;
  }
});

describe("now", () => {
  it("uses NOW_OVERRIDE for deterministic evals", () => {
    process.env.NOW_OVERRIDE = "2026-11-15T12:00:00Z";

    const clock = now("Asia/Kolkata");

    expect(clock.instant.toISOString()).toBe("2026-11-15T12:00:00.000Z");
    expect(clock.iso).toBe("2026-11-15T12:00:00.000Z");
    expect(clock.tz).toBe("Asia/Kolkata");
    expect(clock.human).toContain("15 November 2026");
    expect(clock.human).toContain("Asia/Kolkata");
  });

  it("rejects an invalid NOW_OVERRIDE", () => {
    process.env.NOW_OVERRIDE = "not-a-date";

    expect(() => now("UTC")).toThrow(/NOW_OVERRIDE/);
  });

  it("rejects an unknown timezone", () => {
    delete process.env.NOW_OVERRIDE;

    expect(() => now("Mars/Olympus_Mons")).toThrow(/timezone/i);
  });

  it("reads the real clock when NOW_OVERRIDE is empty", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-11-15T23:30:00Z"));
    process.env.NOW_OVERRIDE = " ";

    expect(now("Asia/Kolkata").iso).toBe("2026-11-15T23:30:00.000Z");
    expect(now("Asia/Kolkata").human).toContain("16 November 2026");
    expect(now("America/New_York").human).toContain("15 November 2026");
  });

  it("uses DEFAULT_TZ when no timezone is supplied", () => {
    vi.stubEnv("DEFAULT_TZ", "America/New_York");
    process.env.NOW_OVERRIDE = "2026-11-15T01:00:00Z";

    expect(now().tz).toBe("America/New_York");
    expect(now().human).toContain("14 November 2026");
  });

  it("normalizes an override with an explicit offset", () => {
    process.env.NOW_OVERRIDE = "2026-11-15T17:30:00+05:30";
    expect(now("UTC").iso).toBe("2026-11-15T12:00:00.000Z");
  });

  it.each(["2026-11-15T12:00:00", "2026-02-30T12:00:00Z"])(
    "rejects a host-dependent or invalid override: %s",
    (override) => {
      process.env.NOW_OVERRIDE = override;
      expect(() => now("UTC")).toThrow(/NOW_OVERRIDE/);
    },
  );
});
