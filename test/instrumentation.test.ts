import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getStore = vi.hoisted(() => vi.fn());
vi.mock("../lib/store", () => ({ getStore }));
import { register } from "../instrumentation";

beforeEach(() => { getStore.mockReset(); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("server startup", () => {
  it("waits for the store before Node startup completes", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    let ready = false;
    let finish!: () => void;
    getStore.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    const registering = register().then(() => { ready = true; });
    await vi.waitFor(() => expect(getStore).toHaveBeenCalledOnce());
    expect(ready).toBe(false);
    finish();
    await registering;
    expect(ready).toBe(true);
  });

  it("does not load the store in the Edge runtime", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    await register();
    expect(getStore).not.toHaveBeenCalled();
  });

  it("fails startup when initialization fails", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    getStore.mockRejectedValue(new Error("database unavailable"));
    await expect(register()).rejects.toThrow("database unavailable");
  });
});
