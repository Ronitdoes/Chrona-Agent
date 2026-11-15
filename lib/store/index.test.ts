import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  end: vi.fn(),
  migrate: vi.fn(),
  drizzle: vi.fn(),
  pool: vi.fn(),
}));

vi.mock("pg", () => ({
  Pool: class {
    constructor(options: unknown) { mocks.pool(options); }
    end = mocks.end;
  },
}));
vi.mock("drizzle-orm/node-postgres", () => ({ drizzle: mocks.drizzle }));
vi.mock("./migrate", () => ({ migrate: mocks.migrate }));

import { createStore } from "./index";

describe("Postgres driver selection", () => {
  const db = {};
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.drizzle.mockReturnValue(db);
    mocks.end.mockResolvedValue(undefined);
    mocks.migrate.mockResolvedValue(undefined);
  });

  it("uses a pg pool and awaits migrations when DATABASE_URL is provided", async () => {
    const store = await createStore({ databaseUrl: " postgres://user@localhost/test " });
    expect(store.driver).toBe("postgres");
    expect(mocks.pool).toHaveBeenCalledWith({ connectionString: "postgres://user@localhost/test", connectionTimeoutMillis: 5_000 });
    expect(mocks.drizzle).toHaveBeenCalledWith(expect.anything(), { schema: expect.objectContaining({ turns: expect.anything() }) });
    expect(mocks.migrate).toHaveBeenCalledWith(db);
    await store.close();
    expect(mocks.end).toHaveBeenCalledOnce();
  });

  it("closes the pool and surfaces startup migration failures", async () => {
    const failure = new Error("migration failed");
    mocks.migrate.mockRejectedValue(failure);
    await expect(createStore({ databaseUrl: "postgres://user@localhost/test" })).rejects.toThrow("Postgres initialization failed");
    expect(mocks.end).toHaveBeenCalledOnce();
  });

  it.each([undefined, "", " ", "invalid", "https://user:secret@localhost/test"])("rejects missing or malformed database URLs before opening a pool %#", async databaseUrl => {
    await expect(createStore({ databaseUrl: databaseUrl as string })).rejects.toThrow();
    expect(mocks.pool).not.toHaveBeenCalled();
  });

  it("reports an unavailable database without leaking connection credentials", async () => {
    mocks.migrate.mockRejectedValue(new Error("connection refused: postgres://user:secret@localhost/test"));
    const error = await createStore({ databaseUrl: "postgres://user:secret@localhost/test" }).catch(error => error);
    expect(error.message).toContain("npm run db:up");
    expect(error.message).not.toContain("secret");
    expect(mocks.end).toHaveBeenCalledOnce();
  });
});
