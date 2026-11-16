import { accountContext } from "./account-context";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const uuid = z.uuid();
export type Session = { userId: string; sessionId: string; cookies: string[] };

function readCookie(request: Request, name: string): string | undefined {
  const values = (request.headers.get("cookie") ?? "").split(";")
    .map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  if (values.length !== 1) return;
  try {
    const parsed = uuid.safeParse(decodeURIComponent(values[0].slice(name.length + 1)));
    return parsed.success ? parsed.data.toLowerCase() : undefined;
  } catch { return; }
}

export function getOrCreateSession(request: Request, requestedSessionId?: string, id: () => string = randomUUID): Session {
  const verified = accountContext.getStore();
  if (verified) return { userId: verified.userId, sessionId: requestedSessionId ?? verified.sessionId, cookies: [] };
  const priorUser = readCookie(request, "user_id");
  const priorSession = priorUser ? readCookie(request, "session_id") : undefined;
  const userId = priorUser ?? id();
  const sessionId = requestedSessionId?.toLowerCase() ?? priorSession ?? id();
  if (!uuid.safeParse(sessionId).success) throw new Error("Invalid session ID");
  const secure = new URL(request.url).protocol === "https:" || process.env.NODE_ENV === "production";
  const cookie = (name: string, value: string) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure ? "; Secure" : ""}`;
  return { userId, sessionId, cookies: [
    ...(!priorUser ? [cookie("user_id", userId)] : []),
    ...(priorSession !== sessionId ? [cookie("session_id", sessionId)] : []),
  ] };
}

export function withSession(response: Response, session: Session): Response {
  for (const cookie of session.cookies) response.headers.append("Set-Cookie", cookie);
  response.headers.set("X-Session-Id", session.sessionId);
  return response;
}
