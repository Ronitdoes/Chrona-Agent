import { describe, expect, it } from "vitest";
import { testDatabaseUrl } from "./database";

describe("integration database safety", () => {
  it("accepts only the dedicated local test service", () => {
    expect(testDatabaseUrl("postgresql://chrona_test:password@127.0.0.1:5433/chrona_test")).toContain(":5433/chrona_test");
  });
  it.each([
    "", "not-a-url", "postgresql://chrona:password@127.0.0.1:5432/chrona",
    "postgresql://chrona_test:password@remote.example:5433/chrona_test",
    "postgresql://chrona_test:password@127.0.0.1:5433/postgres",
    "postgresql://chrona_test:password@127.0.0.1:5433/chrona_test?host=remote.example",
  ])("refuses unsafe admin targets %#", value => {
    expect(() => testDatabaseUrl(value)).toThrow("TEST_DATABASE_URL");
  });
});
