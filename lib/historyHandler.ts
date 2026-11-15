import { z } from "zod";
import { now } from "./clock";
import { decodeCursor, encodeCursor, groupHistory } from "./history";
import { jsonError, timeZone } from "./http";
import { getOrCreateSession, withSession } from "./session";
import { getStore, type Store } from "./store";

const querySchema = z.strictObject({
  sessionId: z.uuid().optional(), before: z.string().max(512).optional(), tz: timeZone.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export function createHistoryHandler(deps: { store: () => Promise<Pick<Store, "historyFor">>; clock: typeof now } = { store: getStore, clock: now }) {
  return async function GET(request: Request): Promise<Response> {
    const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) return jsonError("Invalid history query. Use a valid timezone, sessionId, cursor and limit (1–200).", 400);
    let before;
    try { before = parsed.data.before ? decodeCursor(parsed.data.before) : undefined; }
    catch { return jsonError("Invalid history cursor.", 400); }
    const session = getOrCreateSession(request);
    try {
      const clock = deps.clock(parsed.data.tz);
      const store = await deps.store();
      const rows = await store.historyFor(session.userId, { sessionId: parsed.data.sessionId?.toLowerCase(), before, limit: parsed.data.limit });
      const page = rows.slice(0, parsed.data.limit);
      return withSession(Response.json({
        sessions: groupHistory(page, clock.tz),
        now: clock.iso, tz: clock.tz, activeSessionId: session.sessionId,
        nextCursor: rows.length > parsed.data.limit && page.length ? encodeCursor(page.at(-1)!) : null,
      }, { headers: { "Cache-Control": "private, no-store", Vary: "Cookie" } }), session);
    } catch { return withSession(jsonError("History is temporarily unavailable.", 503), session); }
  };
}
