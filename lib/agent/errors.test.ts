import { describe, expect, it } from "vitest";
import { inputTokenLimit, ModelProviderError, modelFailure, modelFailureMessage, recoveryDelay, retryAfterMs } from "./errors";

describe("safe model failures", () => {
  it.each([
    ["1", 1000], ["0.025", 25], ["0", 0], [" 2 ", 2000],
    [null, undefined], ["", undefined], ["-1", undefined], ["Infinity", undefined],
    ["Sun, 15 Nov 2026 10:00:00 GMT", undefined], ["999999999999999999", undefined],
  ])("parses bounded numeric Retry-After %s", (header, expected) => {
    expect(retryAfterMs(header)).toBe(expected);
  });

  it("retries only known recoverable errors and respects rate-limit guidance", () => {
    for (const kind of ["tool_generation", "unavailable", "network", "stream"] as const) {
      expect(recoveryDelay({ provider: "groq", kind })).toBe(0);
    }
    expect(recoveryDelay({ provider: "groq", kind: "rate_limit", retryAfterMs: 250 })).toBe(250);
    for (const kind of ["authentication", "invalid_request", "unknown", "cancelled", "rate_limit"] as const) {
      expect(recoveryDelay({ provider: "groq", kind })).toBeNull();
    }
  });

  it("never exposes unknown error messages or provider bodies", () => {
    const failure = modelFailure(new Error("secret-provider-body"));
    expect(failure).toEqual({ provider: "unknown", kind: "unknown" });
    expect(modelFailureMessage(failure, true)).toContain("The web search completed");
    expect(modelFailureMessage(failure, true)).not.toContain("secret");
    const typed = new ModelProviderError({ provider: "groq", kind: "rate_limit", status: 429 });
    expect(modelFailure(typed)).toEqual({ provider: "groq", kind: "rate_limit", status: 429 });
    expect(modelFailureMessage(typed.failure, false)).toContain("rate-limiting");
  });

  it("retains only validated numeric input quotas from a size rejection", () => {
    const body = (limit: number, requested: number, axis = "ITPM", code = "rate_limit_exceeded") => ({ error: {
      code, message: `Request too large for private-org on input tokens per minute (${axis}): Limit ${limit}, Requested ${requested}, please reduce your message size.`,
    } });
    expect(inputTokenLimit(body(7000, 17181))).toBe(7000);
    for (const invalid of [null, {}, body(0, 1000), body(7000, 7000), body(7000, 6000), body(7000, 8000, "OTPM"), body(7000, 8000, "ITPM", "other"), body(1e20, 1e21)]) {
      expect(inputTokenLimit(invalid)).toBeUndefined();
    }
    expect(recoveryDelay({ provider: "groq", kind: "request_size", status: 413 })).toBe(0);
    expect(recoveryDelay({ provider: "groq", kind: "request_size" })).toBeNull();
    expect(modelFailureMessage({ provider: "groq", kind: "request_size" }, true)).toContain("input limit");
  });
});
