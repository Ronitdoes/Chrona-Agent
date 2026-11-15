import { createHistoryHandler } from "../../../lib/historyHandler";
import { createDeleteConversationHandler } from "../../../lib/deleteConversation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = createHistoryHandler();
export const DELETE = createDeleteConversationHandler();
