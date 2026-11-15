import { z } from "zod";
import { jsonError } from "./http";
import { acquireChat } from "./requestLimit";
import { getOrCreateSession, withSession } from "./session";
import { getStore, type Store } from "./store";

const query = z.strictObject({ sessionId: z.uuid() });
export function createDeleteConversationHandler(deps: { store: () => Promise<Pick<Store, "deleteConversation">>; acquire: typeof acquireChat } = { store: getStore, acquire: acquireChat }) {
  return async function DELETE(request: Request): Promise<Response> {
    const parsed = query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) return jsonError("Supply a valid conversation sessionId.", 400);
    const session = getOrCreateSession(request);
    const admission = deps.acquire(session.userId);
    if ("retryAfter" in admission) return withSession(jsonError("Wait for the current response to finish before deleting a conversation.", 429, { "Retry-After": String(admission.retryAfter) }), session);
    try {
      const store = await deps.store();
      await store.deleteConversation(session.userId, parsed.data.sessionId.toLowerCase());
      // Idempotent and ownership-private: a missing/foreign ID has the same result.
      return withSession(new Response(null, { status: 204, headers: { "Cache-Control": "private, no-store" } }), session);
    } catch { return withSession(jsonError("The conversation could not be deleted. Please try again.", 503), session); }
    finally { admission.release(); }
  };
}
