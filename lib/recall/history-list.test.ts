import { describe, expect, it, vi } from "vitest";
import { clock, turn } from "../../test/agent-fixtures";
import { dateFrom } from "../clock";
import { historyListingRequest, loadQuestionHistory, renderQuestionHistory } from "./history-list";

describe("history inventory routing", () => {
  it.each([
    "what are all the questions i asked u today?", "what all questions did i ask today", "what are all the things i asked you today",
    "list my messages from today", "show everything I asked yesterday", "What did I ask on 3 November?",
  ])("recognizes %s", text => {
    expect(historyListingRequest(text, clock)?.ranges).toHaveLength(1);
  });
  it.each([
    "What did I ask on 3 November? Is your answer still correct today?", "What questions should I ask today?",
    "What did I ask today about pricing?", "What did I ask today in this chat?", "what is today's news?", "Summarize what I asked today",
    "what did I ask today and answer those questions", "what did I ask", "what did I ask today? Also give the live score", "list my messages today before noon",
    "show my questions on 05/06/2026", "list my messages on 31/02/2026",
  ])("leaves %s to normal recall/reverification", text => {
    expect(historyListingRequest(text, clock)).toBeNull();
  });
  it("supports an explicit all-history inventory without inventing a date", () => {
    expect(historyListingRequest("what all questions did i ask", clock)).toEqual({ ranges: [] });
  });
});

describe("fresh user-message pagination and rendering", () => {
  it("loads past the old 100-turn cutoff and includes recent messages across sessions", async () => {
    const rows = Array.from({ length: 450 }, (_, i) => turn(i + 1, { sessionId: `session-${i % 3}`, content: `Question ${i + 1}`, ts: dateFrom(clock.instant.getTime() - (450 - i) * 1000) }));
    const userMessagesFor = vi.fn(async (_userId: string, options: { before: { id: number }; limit?: number }) => rows.filter(row => row.id < options.before.id).reverse().slice(0, (options.limit ?? 200) + 1));
    const request = historyListingRequest("what are all the questions i asked u today?", clock)!;
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
    const request = historyListingRequest("list my messages today", clock)!;
    const input = { userId: "alice", request, before: { ts: clock.instant, id: 100 } };
    expect((await loadQuestionHistory(input, store)).messages).toHaveLength(1);
    rows.push(turn(2, { sessionId: "new-chat", content: "Latest question", ts: dateFrom(clock.instant.getTime() - 1000) }));
    expect(renderQuestionHistory(await loadQuestionHistory(input, store), request, clock)).toContain("Latest question");
  });
  it("uses the request timezone and local day, including a DST transition", () => {
    const localClock = { ...clock, instant: dateFrom("2026-11-02T05:30:00Z"), iso: "2026-11-02T05:30:00Z", tz: "America/New_York" };
    const request = historyListingRequest("list my messages today", localClock)!;
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
  });
});
