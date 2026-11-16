import { getStore } from "../../../lib/store";
import { after } from "next/server";
import { z } from "zod";
import { createChatHandler } from "../../../lib/chat";
import { privateApi, ownedConversation } from "../../../lib/private-api";
import { accountContext } from "../../../lib/account-context";
import { accountConfig } from "../../../lib/credentials";
import { readJson, jsonError } from "../../../lib/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Vercel Hobby caps serverless functions at 300 seconds.
export const maxDuration = 300;
export const POST = privateApi(async (request, userId) => {
  const body = await readJson(request.clone());
  const parsed = z
    .object({ sessionId: z.uuid(), searchProvider: z.enum(["tavily", "exa"]) })
    .safeParse(body);
  if (!parsed.success)
    return jsonError("Choose a conversation and search provider.", 400);
  if (!(await ownedConversation(userId, parsed.data.sessionId)))
    return jsonError("Conversation unavailable.", 404);
  const config = await accountConfig(userId);
  if (
    !(config.ANTHROPIC_API_KEY || config.GEMINI_API_KEY) ||
    !config[
      parsed.data.searchProvider === "tavily" ? "TAVILY_API_KEY" : "EXA_API_KEY"
    ]
  )
    return jsonError(
      "Add an LLM key and the selected search key in API keys settings.",
      400,
    );
  return accountContext.run(
    {
      userId,
      sessionId: parsed.data.sessionId,
      searchProvider: parsed.data.searchProvider,
      config,
    },
    () =>
      createChatHandler({
        store: async () => {
          const store = await getStore();
          return {
            ...store,
            saveTurn: (input) =>
              store.saveTurn({ ...input, requireOwnedConversation: true }),
          };
        },
        after: (task) =>
          after(() =>
            accountContext.run(
              {
                userId,
                sessionId: parsed.data.sessionId,
                searchProvider: parsed.data.searchProvider,
                config,
              },
              task,
            ),
          ),
      })(request),
  );
});
