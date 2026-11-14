import { afterEach, describe, expect, it } from "vitest";
import { now } from "./clock";

const originalOverride = process.env.NOW_OVERRIDE;

afterEach(() => {
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
});