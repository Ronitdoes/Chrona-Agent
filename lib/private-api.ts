import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getAuth } from "./auth";
import { env } from "./env";
import { getStore } from "./store";
import { conversations } from "./store/schema";
import { jsonError, RequestError } from "./http";
export async function ownedConversation(userId: string, id: string) {
  if (!z.uuid().safeParse(id).success) return false;
  const { db } = await getStore();
  return (
    (
      await db
        .select()
        .from(conversations)
        .where(and(eq(conversations.id, id), eq(conversations.userId, userId)))
    ).length > 0
  );
}
export function privateApi(
  handler: (request: Request, userId: string) => Promise<Response>,
) {
  return async (request: Request): Promise<Response> => {
    try {
      const login = await (
        await getAuth()
      ).api.getSession({ headers: request.headers });
      if (!login) return jsonError("Sign in to continue.", 401);
      if (
        !["GET", "HEAD"].includes(request.method) &&
        request.headers.get("origin") !== new URL(env.BETTER_AUTH_URL).origin
      )
        return jsonError("Invalid request origin.", 403);
      const response = await handler(request, login.user.id);
      response.headers.set("Cache-Control", "private, no-store");
      response.headers.set("Vary", "Cookie");
      return response;
    } catch (error) {
      if (error instanceof RequestError)
        return jsonError(error.message, error.status);
      return jsonError("The service is temporarily unavailable.", 503);
    }
  };
}
