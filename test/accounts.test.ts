import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDatabase } from "./database";
import { dateFrom } from "../lib/clock";
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let store: Awaited<ReturnType<typeof import("../lib/store").getStore>>;
let auth: Awaited<ReturnType<typeof import("../lib/auth").getAuth>>;
let alice: { cookie: string; id: string };
let bob: { cookie: string; id: string };
const origin = "http://localhost:3000";
function request(
  path: string,
  cookie = "",
  method = "GET",
  body?: unknown,
  from = origin,
) {
  return new Request(origin + path, {
    method,
    headers: { cookie, origin: from, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function signup(email: string) {
  const response = await auth.handler(
    request("/api/auth/sign-up/email", "", "POST", {
      email,
      name: email,
      password: "secure-test-password-123",
    }),
  );
  expect(response.status).toBe(200);
  const data = await response.json();
  return {
    id: data.user.id as string,
    cookie: response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; "),
  };
}
beforeAll(async () => {
  database = await createTestDatabase();
  vi.stubEnv("DATABASE_URL", database.databaseUrl);
  vi.stubEnv("BETTER_AUTH_URL", origin);
  store = await (await import("../lib/store")).getStore();
  auth = await (await import("../lib/auth")).getAuth();
  alice = await signup("alice@example.com");
  bob = await signup("bob@example.com");
}, 30000);
afterAll(async () => {
  await store?.close();
  await database?.close();
  vi.unstubAllEnvs();
});
describe("private accounts", { timeout: 30000 }, () => {
  it("rejects anonymous cookies and cross-origin writes", async () => {
    const keys = await import("../app/api/credentials/route");
    expect(
      (
        await keys.GET(
          request(
            "/api/credentials",
            "user_id=11111111-1111-4111-8111-111111111111",
          ),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await keys.PUT(
          request(
            "/api/credentials",
            alice.cookie,
            "PUT",
            { provider: "exa", key: "alice-exa" },
            "https://foreign.example",
          ),
        )
      ).status,
    ).toBe(403);
  });
  it("stores isolated encrypted keys and supports either onboarding combination", async () => {
    const keys = await import("../app/api/credentials/route");
    for (const [account, providers] of [
      [alice, ["gemini", "exa"]],
      [bob, ["anthropic", "tavily"]],
    ] as const) {
      for (const provider of providers)
        expect(
          (
            await keys.PUT(
              request("/api/credentials", account.cookie, "PUT", {
                provider,
                key: `${account.id}-${provider}`,
              }),
            )
          ).status,
        ).toBe(200);
    }
    const { providerCredentials } = await import("../lib/store/schema");
    const rows = await store.db.select().from(providerCredentials);
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => !row.encrypted.includes(row.userId))).toBe(true);
    const status = await (
      await keys.GET(request("/api/credentials", alice.cookie))
    ).json();
    expect(status).toEqual({
      anthropic: false,
      gemini: true,
      tavily: false,
      exa: true,
    });
    const { accountConfig } = await import("../lib/credentials");
    const config = await accountConfig(alice.id);
    expect(config.GEMINI_API_KEY).toBe(`${alice.id}-gemini`);
    expect(config.ANTHROPIC_API_KEY).toBe("");
    const { accountContext, providerConfig } =
      await import("../lib/account-context");
    await accountContext.run(
      { userId: alice.id, sessionId: "test", config, searchProvider: "exa" },
      async () => {
        expect((await providerConfig()).GEMINI_API_KEY).toBe(
          `${alice.id}-gemini`,
        );
        await new Promise((resolve) => setTimeout(resolve, 1));
        expect((await providerConfig()).TAVILY_API_KEY).toBe("");
      },
    );
    expect(
      (
        await keys.PUT(
          request("/api/credentials", alice.cookie, "PUT", {
            provider: "exa",
            key: "replacement",
          }),
        )
      ).status,
    ).toBe(200);
    expect((await accountConfig(alice.id)).EXA_API_KEY).toBe("replacement");
    await keys.DELETE(
      request("/api/credentials?provider=exa", alice.cookie, "DELETE"),
    );
    expect((await accountConfig(alice.id)).EXA_API_KEY).toBe("");
  });
  it("isolates conversation reads, posting, deletion, history and recall", async () => {
    const create = await import("../app/api/conversations/route");
    const history = await import("../app/api/history/route");
    const chat = await import("../app/api/chat/route");
    const response = await create.POST(
      request("/api/conversations", alice.cookie, "POST"),
    );
    const { id } = await response.json();
    await store.saveTurn({
      userId: alice.id,
      sessionId: id,
      role: "user",
      content: "Private question",
      requireOwnedConversation: true,
    });
    expect(
      (await history.GET(request(`/api/history?sessionId=${id}`, alice.cookie)))
        .status,
    ).toBe(200);
    expect(
      (await history.GET(request(`/api/history?sessionId=${id}`, bob.cookie)))
        .status,
    ).toBe(404);
    expect(
      (
        await history.DELETE(
          request(`/api/history?sessionId=${id}`, bob.cookie, "DELETE"),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await chat.POST(
          request("/api/chat", bob.cookie, "POST", {
            sessionId: id,
            searchProvider: "tavily",
            message: "hello",
          }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await chat.POST(
          request("/api/chat", bob.cookie, "POST", {
            sessionId: "11111111-1111-4111-8111-111111111111",
            searchProvider: "tavily",
            message: "hello",
          }),
        )
      ).status,
    ).toBe(404);
    const page = await (
      await history.GET(request("/api/history", bob.cookie))
    ).json();
    expect(page.sessions).toEqual([]);
    expect(
      await store.historyFor(bob.id, { sessionId: id, limit: 20 }),
    ).toEqual([]);
    expect(
      (
        await history.DELETE(
          request(`/api/history?sessionId=${id}`, alice.cookie, "DELETE"),
        )
      ).status,
    ).toBe(204);
    expect(
      (await history.GET(request(`/api/history?sessionId=${id}`, alice.cookie)))
        .status,
    ).toBe(404);
  });
  it("rejects writes to unknown owned-conversation IDs", async () => {
    await expect(
      store.saveTurn({
        userId: alice.id,
        sessionId: "11111111-1111-4111-8111-111111111111",
        role: "user",
        content: "blocked",
        requireOwnedConversation: true,
      }),
    ).rejects.toThrow("Conversation unavailable");
  });
  it("opens an owned deep link beyond the first history page", async () => {
    const create = await import("../app/api/conversations/route");
    const history = await import("../app/api/history/route");
    const { turns } = await import("../lib/store/schema");
    const old = await (await create.POST(request("/api/conversations", alice.cookie, "POST"))).json();
    const recent = await (await create.POST(request("/api/conversations", alice.cookie, "POST"))).json();
    await store.saveTurn({ userId: alice.id, sessionId: old.id, role: "user", content: "Older private question", ts: dateFrom("2020-01-01T00:00:00Z"), requireOwnedConversation: true });
    await store.db.insert(turns).values(Array.from({ length: 205 }, (_, index) => ({ userId: alice.id, sessionId: recent.id, role: "user" as const, content: `Newer question ${index}`, ts: dateFrom("2021-01-01T00:00:00Z") })));
    const page = await (await history.GET(request("/api/history?limit=200", alice.cookie))).json();
    expect(page.sessions.some((entry: { id: string }) => entry.id === old.id)).toBe(false);
    const direct = await (await history.GET(request(`/api/history?sessionId=${old.id}`, alice.cookie))).json();
    expect(direct.sessions[0].id).toBe(old.id);
    expect(direct.sessions[0].days[0].turns[0].content).toBe("Older private question");
  });
  it("supports password sign-in and revokes signed-out and expired sessions", async () => {
    const response = await auth.handler(
      request("/api/auth/sign-in/email", "", "POST", {
        email: "alice@example.com",
        password: "secure-test-password-123",
      }),
    );
    expect(response.status).toBe(200);
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    await auth.handler(request("/api/auth/sign-out", cookie, "POST", {}));
    expect(
      await auth.api.getSession({ headers: new Headers({ cookie }) }),
    ).toBeNull();
    const { session } = await import("../lib/store/schema");
    await store.db
      .update(session)
      .set({ expiresAt: dateFrom(0) })
      .where(eq(session.userId, bob.id));
    expect(
      await auth.api.getSession({
        headers: new Headers({ cookie: bob.cookie }),
      }),
    ).toBeNull();
  });
});
