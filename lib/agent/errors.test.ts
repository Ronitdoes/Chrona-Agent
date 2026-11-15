import { describe, expect, it } from "vitest";
import { ModelProviderError, modelFailure, modelFailureMessage, recoveryDelay, retryAfterMs } from "./errors";

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
      expect(recoveryDelay({ provider: "gemini", kind })).toBe(0);
    }
    expect(recoveryDelay({ provider: "gemini", kind: "rate_limit", retryAfterMs: 250 })).toBe(250);
    for (const kind of ["authentication", "invalid_request", "unknown", "cancelled", "rate_limit"] as const) {
      expect(recoveryDelay({ provider: "gemini", kind })).toBeNull();
    }
  });

  it("never exposes unknown error messages or provider bodies", () => {
    const failure = modelFailure(new Error("secret-provider-body"));
    expect(failure).toEqual({ provider: "unknown", kind: "unknown" });
    expect(modelFailureMessage(failure, true)).toContain("The web search completed");
    expect(modelFailureMessage(failure, true)).not.toContain("secret");
    const typed = new ModelProviderError({ provider: "gemini", kind: "rate_limit", status: 429 });
    expect(modelFailure(typed)).toEqual({ provider: "gemini", kind: "rate_limit", status: 429 });
    expect(modelFailureMessage(typed.failure, false)).toContain("rate-limiting");
  });

  it("does not retry an input-size rejection without a way to shrink the request", () => {
    expect(recoveryDelay({ provider: "gemini", kind: "request_size", status: 413 })).toBeNull();
    expect(modelFailureMessage({ provider: "gemini", kind: "request_size" }, true)).toContain("input limit");
  });
});
