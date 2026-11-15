import { describe, expect, it } from "vitest";
import { dateFrom } from "../clock";
import { diffClaim, revalidateClaim } from "./diff";

describe("diffClaim", () => {
  const cases = [
    ["$20/seat/mo", "$23 per user per month", "changed"],
    ["$20/seat/mo", "USD 20.00 per user per month", "unchanged"],
    ["US$20 per seat monthly", "20 USD / user / month", "unchanged"],
    ["€20/month", "EUR 20 per month", "unchanged"],
    ["£20/mo", "GBP 21 monthly", "changed"],
    ["₹1,000/mo", "INR 1000.00 per month", "unchanged"],
    ["€1.234,50/year", "EUR 1,234.50 annually", "unchanged"],
    ["$0.100000/mo", "$0.1 monthly", "unchanged"],
    ["$9007199254740992/mo", "$9007199254740993/mo", "changed"],
    ["$20/seat/mo", "$20 per user per year", "changed"],
    ["$20/mo", "$240/year", "changed"],
    ["$20/month", "EUR 20 per month", "unknown"],
    ["C$20/mo", "CAD 20 monthly", "unchanged"],
    ["A$20/mo", "AUD 20 monthly", "unchanged"],
    ["$20/seat/mo", "$20 per month", "unknown"],
    ["$20/seat/mo", "$20 per request per month", "unknown"],
    ["$20/seat/mo", "$20 per seat monthly, billed annually", "unknown"],
    ["$20/seat/mo billed annually", "$20 per user monthly, billed yearly", "unchanged"],
    ["$20/seat/mo billed annually", "$20 per user monthly, billed monthly", "changed"],
    ["$20/seat/mo", "Contact sales for pricing", "unknown"],
    ["$20/mo", "Free trial for 30 days", "unknown"],
    ["$20/mo", "Starter $20/mo; Pro $30/mo", "unknown"],
    ["$20/mo", "The price is $20/mo. It remains USD 20 monthly.", "unchanged"],
    ["v4.2", "4.2.0", "unchanged"],
    ["4.2.0", "The latest release is v4.3.0", "changed"],
    ["v4", "version 4.0.0", "unchanged"],
    ["v4.2.0-beta.1", "4.2.0", "changed"],
    ["v4.2.0+build.1", "v4.2+build.2", "unchanged"],
    ["v4.2", "Plans cost $4.20", "unknown"],
    ["v4.2", "v4.2 and v5.0 are available", "unknown"],
    ["v4.2", "No release information", "unknown"],
    ["true", "Enabled", "unchanged"],
    ["yes", "The feature is disabled.", "changed"],
    ["false", "SSO is now supported.", "changed"],
    ["supported", "This feature is not supported.", "changed"],
    ["false", "The feature is not enabled.", "unchanged"],
    ["false", "It is unsupported.", "unchanged"],
    ["true", "Enabled on Pro, disabled on Starter", "unknown"],
    ["true", "Details are available on request", "unknown"],
    ["true", "No changes have been announced.", "unknown"],
    ["true", "The feature isn't supported.", "changed"],
    ["true", "SSO is never enabled.", "changed"],
    ["true", "SSO is no longer supported.", "changed"],
    ["20 seats", "20 users", "unchanged"],
    ["20 users", "25 seats", "changed"],
    ["1 GB", "1000 MB", "unchanged"],
    ["1 GiB", "1024 MiB", "unchanged"],
    ["1 GB", "1 GiB", "changed"],
    ["100 requests/day", "100 requests per day", "unchanged"],
    ["100 requests/day", "100 requests per month", "changed"],
    ["99.9%", "Uptime is 99.95%", "changed"],
    ["20 seats", "20 projects", "unknown"],
    ["unknown", "$20/month", "unknown"],
    ["$20/mo", "", "unknown"],
    ["", "", "unknown"],
  ] as const;

  it.each(cases)("compares %s against %s as %s", (oldValue, evidence, verdict) => {
    expect(diffClaim(oldValue, evidence).verdict).toBe(verdict);
  });

  it("returns the extracted canonical values", () => {
    expect(diffClaim("$20/seat/mo", "$23 per user per month")).toMatchObject({
      verdict: "changed",
      oldParsed: { kind: "money", currency: "USD", amount: "20", unit: "seat", period: "month" },
      newParsed: { kind: "money", currency: "USD", amount: "23", unit: "seat", period: "month" },
    });
    expect(diffClaim("v4.2", "4.2.0").newParsed).toEqual({ kind: "version", version: "4.2.0" });
  });

  it("does not modify either input and produces the same result repeatedly", () => {
    const oldValue = "$20/seat/mo";
    const evidence = "$23 per user per month";
    expect(diffClaim(oldValue, evidence)).toEqual(diffClaim(oldValue, evidence));
    expect(oldValue).toBe("$20/seat/mo");
    expect(evidence).toBe("$23 per user per month");
  });
});

describe("dated claim revalidation", () => {
  const asOf = dateFrom("2026-11-03T12:00:00Z");
  const now = dateFrom("2026-11-15T12:00:00Z");
  const claim = { value: "$20/seat/mo", asOf };

  it.each([null, "2026-11-02T12:00:00Z", "2026-11-03T12:00:00Z", "2026-11-16T12:00:00Z"])(
    "requires a dated, newer source no later than now (%s)", (raw) => {
      const publishedAt = raw ? dateFrom(raw) : null;
      expect(revalidateClaim(claim, { text: "$20/seat/mo", publishedAt }, now).verdict).toBe("unknown");
      expect(revalidateClaim(claim, { text: "$23/seat/mo", publishedAt }, now).verdict).toBe("unknown");
    },
  );

  it("accepts newer dated evidence for both confirmed equality and change", () => {
    const publishedAt = dateFrom("2026-11-14T12:00:00Z");
    expect(revalidateClaim(claim, { text: "$20 per user monthly", publishedAt }, now).verdict).toBe("unchanged");
    expect(revalidateClaim(claim, { text: "$23 per user monthly", publishedAt }, now).verdict).toBe("changed");
  });

  it("keeps missing or conflicting values unknown even with a newer date", () => {
    const publishedAt = now;
    expect(revalidateClaim(claim, { text: "No pricing available", publishedAt }, now).verdict).toBe("unknown");
    expect(revalidateClaim(claim, { text: "$20/seat/mo or $23/seat/mo", publishedAt }, now).verdict).toBe("unknown");
  });

  it("treats invalid timestamps as unverifiable and retains extracted values", () => {
    const invalid = dateFrom(NaN);
    expect(revalidateClaim(claim, { text: "$23/seat/mo", publishedAt: invalid }, now)).toMatchObject({
      verdict: "unknown", oldParsed: { amount: "20" }, newParsed: { amount: "23" },
    });
    expect(revalidateClaim({ ...claim, asOf: invalid }, { text: "$23/seat/mo", publishedAt: now }, now).verdict).toBe("unknown");
    expect(revalidateClaim(claim, { text: "$23/seat/mo", publishedAt: now }, invalid).verdict).toBe("unknown");
  });
});
