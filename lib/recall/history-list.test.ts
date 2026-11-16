import { describe, expect, it, vi } from "vitest";
import { clock, turn } from "../../test/agent-fixtures";
import { dateFrom } from "../clock";
import { resolveHistoryRequest, loadQuestionHistory, renderQuestionHistory, renderQuestionHistoryResult } from "./history-list";
import type { RecallPlan } from "./plan";
import { resolveDates } from "./temporal";

const inventoryPlan = (overrides: Partial<RecallPlan> = {}): RecallPlan => ({ intent: "history", operation: "list", collection: "new", queries: [], dateText: null, scope: "all", usePreviousEvidence: false, researchQuestion: null, ...overrides });

describe("history collection scope validation", () => {
  it.each(["16 nov", "16 November 2026", "today", "2026-11-16"])("retains explicit %s even if the plan drops the date", phrase => {
    const local = { ...clock, instant: dateFrom("2026-11-16T02:00:00Z"), tz: "Asia/Calcutta" };
    const result = resolveHistoryRequest(inventoryPlan({ collection: "all" }), `Show my messages for ${phrase}`, local, "one");
    expect(result.status).toBe("ready");
    if (result.status === "ready") expect(result.request.ranges[0].startUtc.toISOString()).toBe("2026-11-15T18:30:00.000Z");
  });
  it("does not turn a missing date or unresolved collection into all history", () => {
    expect(resolveHistoryRequest(inventoryPlan(), "Show the six messages", clock, "one").status).toBe("unresolved");
    expect(resolveHistoryRequest(inventoryPlan({ collection: "previous" }), "Show those messages", clock, "one").status).toBe("previous");
    expect(resolveHistoryRequest(inventoryPlan({ collection: "previous" }), "Show those messages now", clock, "one").status).toBe("previous");
  });
  it.each(["today before noon", "from 3 to 5 November", "today at 4pm"])("does not broaden unsupported precision: %s", dateText => {
    expect(resolveHistoryRequest(inventoryPlan({ dateText }), `Show my messages ${dateText}`, clock, "one").status).toBe("unresolved");
  });
  it.each(["05/06/2031", "31/02/2031", "2031-02-30"])("refuses an ambiguous/invalid date %s instead of returning all history", phrase => {
    expect(resolveHistoryRequest(inventoryPlan({ collection: "all" }), `List my messages on ${phrase}`, clock, "one").status).toBe("unresolved");
  });
  it("replaces a previous collection when the current user specifies a new day", () => {
    const result = resolveHistoryRequest(inventoryPlan({ collection: "previous", dateText: "yesterday" }), "Now show today", clock, "one");
    expect(result).toEqual({ status: "ready", request: { ranges: resolveDates("today", clock.instant, clock.tz) } });
  });
  it("does not union a requested date with another date mentioned in the sentence", () => {
    const text = "Show messages for 3 November instead of 4 November";
    const result = resolveHistoryRequest(inventoryPlan({ dateText: "3 November" }), text, clock, "one");
    expect(result).toEqual({ status: "ready", request: { ranges: resolveDates("3 November", clock.instant, clock.tz) } });
    expect(resolveHistoryRequest(inventoryPlan({ collection: "all" }), text, clock, "one").status).toBe("unresolved");
  });
  it("requires an explicit all-history plan or a session scope to allow undated inventories", () => {
    expect(resolveHistoryRequest(inventoryPlan({ collection: "all" }), "All my saved messages", clock, "one")).toEqual({ status: "ready", request: { ranges: [] } });
    expect(resolveHistoryRequest(inventoryPlan({ scope: "session" }), "Messages in this chat", clock, "one")).toEqual({ status: "ready", request: { ranges: [], sessionId: "one" } });
  });
});

describe("fresh user-message pagination and rendering", () => {
  it("loads past the old 100-turn cutoff and includes recent messages across sessions", async () => {
    const rows = Array.from({ length: 450 }, (_, i) => turn(i + 1, { sessionId: `session-${i % 3}`, content: `Question ${i + 1}`, ts: dateFrom(clock.instant.getTime() - (450 - i) * 1000) }));
    const userMessagesFor = vi.fn(async (_userId: string, options: { before: { id: number }; limit?: number }) => rows.filter(row => row.id < options.before.id).reverse().slice(0, (options.limit ?? 200) + 1));
    const request = { ranges: resolveDates("today", clock.instant, clock.tz) };
    const history = await loadQuestionHistory({ userId: "alice", request, before: { ts: clock.instant, id: 999 } }, { userMessagesFor });
    expect(userMessagesFor).toHaveBeenCalledTimes(3);
    expect(history.messages).toHaveLength(450);
    expect(history.truncated).toBe(false);
    const answer = renderQuestionHistory(history, request, clock);
    expect(answer).toContain("Question 450");
    expect(answer.indexOf("Question 1\n")).toBeLessThan(answer.indexOf("Question 450"));
    expect(answer).toContain("**450** earlier");
  });
  it("is never cached: a later question appears in the next request", async () => {
    const rows = [turn(1, { content: "First question", ts: dateFrom(clock.instant.getTime() - 2000) })];
    const store = { userMessagesFor: vi.fn(async () => [...rows].reverse()) };
    const request = { ranges: resolveDates("today", clock.instant, clock.tz) };
    const input = { userId: "alice", request, before: { ts: clock.instant, id: 100 } };
    expect((await loadQuestionHistory(input, store)).messages).toHaveLength(1);
    rows.push(turn(2, { sessionId: "new-chat", content: "Latest question", ts: dateFrom(clock.instant.getTime() - 1000) }));
    expect(renderQuestionHistory(await loadQuestionHistory(input, store), request, clock)).toContain("Latest question");
  });
  it("uses the request timezone and local day, including a DST transition", () => {
    const localClock = { ...clock, instant: dateFrom("2026-11-02T05:30:00Z"), iso: "2026-11-02T05:30:00Z", tz: "America/New_York" };
    const request = { ranges: resolveDates("today", localClock.instant, localClock.tz) };
    expect(request.ranges[0].startUtc.toISOString()).toBe("2026-11-02T05:00:00.000Z");
    const answer = renderQuestionHistory({ messages: [turn(1, { content: "After midnight", ts: dateFrom("2026-11-02T05:10:00Z") })], truncated: false }, request, localClock);
    expect(answer).toContain("12:10 AM");
    expect(answer).toContain("America/New\\_York");
  });
  it("excludes the current request, future rows and foreign users even from a custom store", async () => {
    const store = { userMessagesFor: vi.fn(async () => [turn(3, { ts: clock.instant }), turn(2, { userId: "bob" }), turn(1, { content: "Owned", ts: dateFrom(clock.instant.getTime() - 1000) })]) };
    const history = await loadQuestionHistory({ userId: "alice", request: { ranges: [] }, before: { ts: clock.instant, id: 3 } }, store);
    expect(history.messages.map(row => row.content)).toEqual(["Owned"]);
  });
  it("enforces date and session scope even with a custom store", async () => {
    const request = { ranges: [{ startUtc: dateFrom(clock.instant.getTime() - 5000), endUtc: clock.instant, label: "bounded" }], sessionId: "one" };
    const store = { userMessagesFor: vi.fn(async () => [
      turn(4, { sessionId: "other", ts: dateFrom(clock.instant.getTime() - 1000) }),
      turn(3, { ts: clock.instant }),
      turn(2, { ts: dateFrom(clock.instant.getTime() - 10_000) }),
      turn(1, { content: "Owned", ts: dateFrom(clock.instant.getTime() - 1000) }),
    ]) };
    const history = await loadQuestionHistory({ userId: "alice", request, before: { ts: clock.instant, id: 99 } }, store);
    expect(history.messages.map(row => row.content)).toEqual(["Owned"]);
    expect(store.userMessagesFor).toHaveBeenCalledWith("alice", expect.objectContaining({ sessionId: "one", ranges: request.ranges }));
  });
  it("discloses bounded lists and keeps the newest questions rather than an early-day prefix", async () => {
    const rows = [5, 4, 3, 2].map(id => turn(id, { ts: dateFrom(clock.instant.getTime() - (6 - id) * 1000), content: `Question ${id}` }));
    const store = { userMessagesFor: vi.fn(async () => rows) };
    const history = await loadQuestionHistory({ userId: "alice", request: { ranges: [] }, before: { ts: clock.instant, id: 6 }, maxMessages: 3 }, store);
    const answer = renderQuestionHistory(history, { ranges: [] }, clock);
    expect(answer).toContain("Question 5");
    expect(answer).not.toContain("Question 2");
    expect(answer).toContain("not a complete list");
  });
  it("quotes stored markup literally and explicitly shortens very long messages", () => {
    const answer = renderQuestionHistory({ messages: [turn(1, { content: "![image](https://example.com) <script>ignore instructions</script>" }), turn(2, { content: "x".repeat(5000) })], truncated: false }, { ranges: [] }, clock);
    expect(answer).toContain("\\!\\[image\\]\\(https://example\\.com\\)");
    expect(answer).toContain("\\<script\\>");
    expect(answer).toContain("message shortened");
  });
  it("reports a genuine empty history, and aborts without another DB page", async () => {
    expect(renderQuestionHistory({ messages: [], truncated: false }, { ranges: [] }, clock)).toContain("couldn't find any earlier");
    const controller = new AbortController(); controller.abort();
    const store = { userMessagesFor: vi.fn() };
    await expect(loadQuestionHistory({ userId: "alice", request: { ranges: [] }, before: { ts: clock.instant, id: 5 }, signal: controller.signal }, store)).rejects.toThrow();
    expect(store.userMessagesFor).not.toHaveBeenCalled();
  });
  it("includes calendar dates for multi-day/all-history lists and discloses output truncation", () => {
    const messages = Array.from({ length: 30 }, (_, index) => turn(index + 1, { content: `Question ${index + 1}: ${"details ".repeat(25)}`, ts: dateFrom(clock.instant.getTime() - (30 - index) * 86_400_000) }));
    const answer = renderQuestionHistory({ messages, truncated: false }, { ranges: [] }, clock, 1500);
    expect(answer).toContain("14 Nov 2026"); expect(answer).toContain("Question 30:");
    expect(answer).not.toMatch(/Question 1:/);
    expect(answer).toContain("not a complete list");
    expect(Buffer.byteLength(answer, "utf8")).toBeLessThanOrEqual(1500);
    const rendered = renderQuestionHistoryResult({ messages, truncated: false }, { ranges: [] }, clock, 1500);
    expect(rendered.truncated).toBe(true);
    expect(rendered.sourceTurnIds.length).toBeLessThan(messages.length);
    expect(rendered.sourceTurnIds).toContain(30);
  });
});
