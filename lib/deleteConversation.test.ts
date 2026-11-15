import { describe, expect, it, vi } from "vitest";
import { createDeleteConversationHandler } from "./deleteConversation";
import { createRequestLimit } from "./requestLimit";

const userId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const request = (query = `sessionId=${sessionId}`) => new Request(`http://localhost/api/history?${query}`, { method: "DELETE", headers: { cookie: `user_id=${userId}; session_id=${sessionId}` } });
describe("conversation deletion endpoint", () => {
  it.each([true, false])("is idempotent and scoped only by the authenticated cookie identity (%s)", async found => {
    const remove = vi.fn().mockResolvedValue(found);
    const handler = createDeleteConversationHandler({ store: async () => ({ deleteConversation: remove }), acquire: createRequestLimit(() => 0) });
    const response = await handler(request());
    expect(response.status).toBe(204);
    expect(remove).toHaveBeenCalledWith(userId, sessionId);
  });
  it("validates IDs and rejects forged owner parameters before querying", async () => {
    const store = vi.fn();
    const handler = createDeleteConversationHandler({ store, acquire: createRequestLimit(() => 0) });
    expect((await handler(request("sessionId=invalid"))).status).toBe(400);
    expect((await handler(request(`sessionId=${sessionId}&userId=bob`))).status).toBe(400);
    expect(store).not.toHaveBeenCalled();
  });
  it("does not delete during an active response and releases its own lease after failure", async () => {
    const acquire = createRequestLimit(() => 0);
    const active = acquire(userId);
    const remove = vi.fn().mockRejectedValueOnce(new Error("secret database password")).mockResolvedValueOnce(true);
    const handler = createDeleteConversationHandler({ store: async () => ({ deleteConversation: remove }), acquire });
    expect((await handler(request())).status).toBe(429);
    expect(remove).not.toHaveBeenCalled();
    if ("release" in active) active.release();
    const failed = await handler(request());
    expect(failed.status).toBe(503); expect(await failed.text()).not.toContain("secret");
    expect((await handler(request())).status).toBe(204);
  });
});
