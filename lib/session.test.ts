import { describe, expect, it } from "vitest";
import { getOrCreateSession, withSession } from "./session";

const user = "11111111-1111-4111-8111-111111111111";
const session = "22222222-2222-4222-8222-222222222222";
const other = "33333333-3333-4333-8333-333333333333";
describe("anonymous sessions", () => {
  it("creates separate user and conversation cookies before streaming", () => {
    const ids = [user, session];
    const result = getOrCreateSession(new Request("https://example.com/api/chat"), undefined, () => ids.shift()!);
    expect(result.userId).toBe(user);
    expect(result.sessionId).toBe(session);
    const response = withSession(new Response("ok"), result);
    expect(response.headers.getSetCookie()).toHaveLength(2);
    expect(result.cookies.every((cookie) => cookie.includes("HttpOnly; SameSite=Lax") && cookie.endsWith("; Secure"))).toBe(true);
    expect(response.headers.get("X-Session-Id")).toBe(session);
  });
  it("reuses identity across conversations and changes only the selected session", () => {
    const request = new Request("http://localhost/api/chat", { headers: { cookie: `user_id=${user}; session_id=${session}` } });
    expect(getOrCreateSession(request).cookies).toEqual([]);
    const next = getOrCreateSession(request, other);
    expect(next.userId).toBe(user);
    expect(next.sessionId).toBe(other);
    expect(next.cookies).toHaveLength(1);
    expect(next.cookies[0]).toContain("session_id=");
  });
  it("replaces malformed, duplicated or missing identity cookies without trusting a body ID", () => {
    for (const cookie of ["user_id=malformed", `user_id=${user}; user_id=${user}`, `user_id=%ZZ; session_id=${session}`]) {
      const ids = [other, session];
      const result = getOrCreateSession(new Request("http://localhost", { headers: { cookie } }), undefined, () => ids.shift()!);
      expect(result.userId).toBe(other);
      expect(result.cookies).toHaveLength(2);
    }
  });
});
