import { createTestStore } from "../../test/database";
import { expect, it } from "vitest";
import { claims } from "../store/schema";
import { dateFrom } from "../clock";
import { clock } from "../../test/agent-fixtures";
import { retrieve } from "./retrieve";

it("retrieves dated pairs and cross-session keyword context from real Postgres, scoped to the user", async () => {
  const store = await createTestStore({ clock: () => clock });
  try {
    await store.saveTurn({ userId: "alice", sessionId: "one", role: "user", content: "Compare CRM pricing", ts: dateFrom("2026-11-09T12:00:00Z") });
    const answer = await store.saveTurn({ userId: "alice", sessionId: "one", role: "assistant", content: "HubSpot CRM costs $20/seat/mo", ts: dateFrom("2026-11-09T12:00:01Z") });
    await store.saveTurn({ userId: "alice", sessionId: "two", role: "user", content: "Hosting database prices", ts: dateFrom("2026-11-10T12:00:00Z") });
    await store.saveTurn({ userId: "bob", sessionId: "private", role: "user", content: "Private CRM pricing", ts: dateFrom("2026-11-09T12:00:00Z") });
    await store.db.insert(claims).values({ turnId: answer.id, userId: "alice", subject: "HubSpot CRM", attribute: "price", value: "$20/seat/mo", asOf: answer.ts });
    const dated = await retrieve({ userId: "alice", text: "Monday", now: clock }, { store });
    expect(dated.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
    expect(dated.claims[0].turnId).toBe(answer.id);
    const lexical = await retrieve({ userId: "alice", text: "What did I ask about CRM pricing?", now: clock }, { store });
    expect(lexical.matchedBy).toBe("keyword");
    expect(lexical.turns.every((turn) => turn.userId === "alice")).toBe(true);
    expect(lexical.turns.some((turn) => turn.id === answer.id)).toBe(true);
    const missing = await retrieve({ userId: "alice", text: "What did I ask on 3 November?", now: clock }, { store });
    expect(missing.notFound).toBe(true);
  } finally { await store.close(); }
}, 30_000);
