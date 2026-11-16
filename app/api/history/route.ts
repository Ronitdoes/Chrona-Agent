import { randomUUID } from "node:crypto";
import { createHistoryHandler } from "../../../lib/historyHandler";
import { createDeleteConversationHandler } from "../../../lib/deleteConversation";
import { privateApi, ownedConversation } from "../../../lib/private-api";
import { accountContext } from "../../../lib/account-context";
import { env } from "../../../lib/env";
import { jsonError } from "../../../lib/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handle(request: Request, userId: string) {
  const id = new URL(request.url).searchParams.get("sessionId");
  if (id && !(await ownedConversation(userId, id)))
    return jsonError("Conversation unavailable.", 404);
  if (request.method === "DELETE" && !id)
    return jsonError("Choose a conversation.", 400);
  const response = await accountContext.run(
    {
      userId,
      sessionId: id ?? randomUUID(),
      config: env,
      searchProvider: "tavily",
    },
    () =>
      request.method === "DELETE"
        ? createDeleteConversationHandler()(request)
        : createHistoryHandler()(request),
  );
  return response;
}
export const GET = privateApi(handle);
export const DELETE = privateApi(handle);
