import { expect, it } from "vitest";
import { createRequestLimit } from "./requestLimit";

it("limits concurrent turns per user, bounds the rolling window and releases idempotently", () => {
  let time = 0;
  const acquire = createRequestLimit(() => time, 2);
  const first = acquire("alice");
  expect(acquire("alice")).toEqual({ retryAfter: 1 });
  if (!("release" in first)) throw new Error("Expected admission");
  first.release();
  const second = acquire("alice");
  first.release();
  expect(acquire("alice")).toEqual({ retryAfter: 1 });
  if (!("release" in second)) throw new Error("Expected admission");
  second.release();
  expect(acquire("alice")).toEqual({ retryAfter: 60 });
  expect(acquire("bob")).toHaveProperty("release");
  time = 60_000;
  expect(acquire("alice")).toHaveProperty("release");
});
