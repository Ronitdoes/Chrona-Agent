import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createChatHandler } from "../lib/chat";
import { dateFrom, monotonicMs } from "../lib/clock";
import { runAgent } from "../lib/agent/loop";
import type { AgentModel, ModelRequest } from "../lib/agent/model";
import type { ModelSelection } from "../lib/model-selection";
import { createRequestLimit } from "../lib/requestLimit";
import { revalidateClaim } from "../lib/recall/diff";
import { resolveDates } from "../lib/recall/temporal";
import type { RecallModel, RecallPlan } from "../lib/recall/plan";
import { effortProfiles } from "../lib/research-effort";
import type { Store } from "../lib/store";
import { claims } from "../lib/store/schema";
import { FakeSearchProvider } from "../lib/tools/providers/fake";
import { createWebSearch } from "../lib/tools/webSearch";
import { FakeModel } from "../test/agent-fixtures";
import { createTestStore } from "../test/database";
import { checkAnswer, checkMetrics, type EvalRow, type Metrics } from "./checks";
import { evalClock, evalUser, recordedAnswer, scenarios, type Scenario } from "./fixtures";

export async function seedFixtures(store: Store) {
  const ids = new Map<string, number>();
  for (const scenario of scenarios) {
    const sessionId = randomUUID();
    const user = await store.saveTurn({ userId: evalUser, sessionId, role: "user", content: scenario.original, ts: dateFrom(`${scenario.date}T10:00:00Z`), tz: "UTC" });
    const answer = await store.saveTurn({ userId: evalUser, sessionId, role: "assistant", content: scenario.answer, ts: dateFrom(`${scenario.date}T10:00:01Z`), tz: "UTC" });
    ids.set(scenario.id, user.id);
    await store.db.insert(claims).values(scenario.items.map(item => ({ userId: evalUser, turnId: answer.id, subject: item.subject,
      attribute: "price", value: item.old, asOf: answer.ts, sourceUrls: [item.url] })));
  }
  // A matching private message must never appear in another user's evidence.
  await store.saveTurn({ userId: "another-user", sessionId: randomUUID(), role: "user", content: scenarios[0].original, ts: dateFrom("2026-11-09T11:00:00Z") });
  return ids;
}

type RunOptions = { missing?: boolean; exhaustQueries?: boolean; live?: { selection: ModelSelection; answer: AgentModel; recall: RecallModel } };
export async function evaluate(scenario: Scenario, row: EvalRow, options: RunOptions = {}) {
  const store = await createTestStore({ clock: () => evalClock });
  try {
    const ids = await seedFixtures(store);
    const tasks: (() => Promise<void>)[] = [];
    const requests: ModelRequest[] = [];
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const searchInputs: unknown[] = [];
    let trace: Record<string, unknown> | undefined;
    let research: Awaited<ReturnType<typeof runAgent>> | undefined;
    let curatorCalls = 0;
    const sourceId = ids.get(scenario.id)!;
    const plan: RecallPlan = { intent: options.missing ? "history" : "mixed", operation: options.missing ? "list" : "revalidate",
      queries: scenario.id === "Tuesday Postgres" && !options.missing ? ["Postgres hosting pricing", "Postgres hosting cost", "Postgres hosting"] : [],
      dateText: options.missing ? "2 November" : scenario.dateText, scope: "all", usePreviousEvidence: false,
      researchQuestion: options.missing ? null : `Search the web to revalidate the pricing of ${scenario.items.map(item => item.subject).join(", ")} since ${scenario.date}. Report each old and new value, verdict, dated source or verification limit.` };
    const model = options.live?.answer ?? new FakeModel([
      { tools: [{ input: { queries: [...scenario.queries, ...(options.exhaustQueries ? ["extra omitted query"] : [])], since: scenario.date, prefer_official: true, depth: scenario.depth === "deep" ? "deep" : "fast" } }] },
      { text: [recordedAnswer(scenario)] },
    ]);
    const measuredModel: AgentModel = { stream(request, settings) { requests.push(request); return model.stream(request, settings); } };
    const provider = new FakeSearchProvider(request => {
      const matched = scenario.items.filter(item => request.query.toLowerCase().includes(item.subject.toLowerCase()));
      return (matched.length ? matched : scenario.items).map(item => ({ title: `${item.subject} synthetic pricing`, url: item.url,
        snippet: `${item.subject} costs ${item.current}.`, published_date: item.published }));
    });
    const search = createWebSearch({ primary: provider, clock: () => evalClock, officialDomains: () => ["example.com"] });
    const planner: RecallModel = options.live?.recall ?? {
      plan: async () => plan,
      select: async input => {
        const selected = input.candidates.find(candidate => candidate.id === sourceId);
        return selected ? { status: "matched", matches: [{ turnId: selected.id, quote: selected.content }] } : { status: "not_found", matches: [] };
      },
    };
    let observedPlan: unknown;
    const measuredPlanner: RecallModel = {
      plan: async (input, signal) => { observedPlan = await planner.plan(input, signal); return observedPlan as RecallPlan; },
      select: (input, signal) => planner.select(input, signal),
    };
    const handler = createChatHandler({ store: async () => store, clock: () => evalClock, time: monotonicMs,
      after: task => { tasks.push(task); }, acquire: createRequestLimit(monotonicMs),
      resolveSelection: async requested => requested ?? options.live?.selection ?? { provider: "gemini", model: "recorded-eval" },
      recallModel: async () => measuredPlanner,
      trace: () => ({ info: data => { trace = data; }, error: data => { trace = data; } }),
      curate: async () => { curatorCalls++; throw new Error("Mixed/history evaluations must not invoke curation"); },
      run: async settings => {
        research = await runAgent({ ...settings, model: measuredModel, search: async (input, settings) => { searchInputs.push(input); return search(input, settings); } });
        return research;
      },
    });
    const sessionId = randomUUID();
    const response = await handler(new Request("http://localhost/api/chat", { method: "POST",
      headers: { "Content-Type": "application/json", cookie: `user_id=${evalUser}; session_id=${sessionId}` },
      body: JSON.stringify({ message: options.missing ? "What did I ask on 2 November?" : scenario.message, tz: "UTC", effort: "medium" }),
    }));
    assert.equal(response.status, 200);
    const body = await response.text();
    for (const block of body.trim().split("\n\n")) {
      const [event, data] = block.split("\n");
      events.push({ event: event.slice(7), data: JSON.parse(data.slice(6)) });
    }
    for (const task of tasks) await task();
    assert.ok(trace, "Missing request trace");
    const metrics = trace as Metrics;
    Object.assign(row, { recallMs: metrics.recallMs, ttftMs: metrics.ttftMs, totalMs: metrics.totalMs, searchCount: metrics.searchCount, toolCalls: searchInputs.length });
    assert.equal(events.filter(event => event.event === "done").length, 1, "SSE must terminate exactly once");
    assert.equal(events.filter(event => event.event === "error").length, 0, "Unexpected SSE error");
    assert.equal(trace.failure, null);
    assert.equal(trace.userPersisted, true); assert.equal(trace.assistantPersisted, true);
    assert.equal(curatorCalls, 0, "Mixed/history evaluations must not invoke curation");
    checkMetrics(metrics, effortProfiles.medium.maxWallMs);
    const answer = events.filter(event => event.event === "delta").map(event => event.data.text).join("");
    if (options.live) console.log(JSON.stringify({ syntheticLiveDiagnostic: { plan: observedPlan, recall: trace.recall, searchBatches: searchInputs, answer } }, null, 2));
    if (options.missing) {
      assert.match(answer, /couldn't (?:locate an original matching message|find any earlier questions or messages)/);
      assert.ok(scenarios.every(scenario => !answer.includes(scenario.original)), "Missing history must not invent a stored question");
      assert.equal(requests.length, 0); assert.equal(searchInputs.length, 0);
    } else {
      const ranges = resolveDates(scenario.dateText, evalClock.instant, "UTC");
      assert.equal(ranges[0].startUtc.toISOString(), `${scenario.date}T00:00:00.000Z`);
      const history = trace.recall as { status: string; evidenceIds: number[] };
      assert.equal(history.status, "matched"); assert.deepEqual(history.evidenceIds, [sourceId]);
      assert.equal(searchInputs.length, 1, "All items must share one web_search call");
      if (!options.live) {
        assert.deepEqual(provider.calls.map(call => call.query), scenario.queries);
        assert.ok(provider.calls.every(call => call.since === scenario.date));
        assert.ok(provider.calls.every(call => call.depth === (scenario.depth === "deep" ? "deep" : "fast")));
        const baseline = JSON.stringify(requests[0].system);
        assert.ok(baseline.includes(scenario.original)); assert.ok(baseline.includes(scenario.answer));
      }
      for (const request of requests) {
        assert.deepEqual(request.tools?.map(tool => "name" in tool ? tool.name : ""), ["web_search"]);
      }
      assert.ok(research && research.steps <= effortProfiles.medium.maxSteps);
      assert.ok(research.searchCount <= effortProfiles.medium.maxQueries && research.sources.length <= effortProfiles.medium.maxSources);
      if (options.exhaustQueries) assert.ok(research.limits.length > 0, "Query exhaustion must be disclosed");
      else assert.deepEqual(research.limits, []);
      for (const item of scenario.items) {
        const verdict = revalidateClaim({ value: item.old, asOf: dateFrom(`${scenario.date}T10:00:01Z`) },
          { text: item.current, publishedAt: item.published ? dateFrom(item.published) : null }, evalClock.instant);
        assert.equal(verdict.verdict, item.verdict, `${item.subject}: deterministic diff/date-gate regression`);
      }
      checkAnswer(answer, scenario);
    }
    const saved = await store.historyFor(evalUser, { sessionId });
    assert.equal(saved.length, 2); assert.equal(saved[0].content, answer);
    row.status = "PASS";
  } catch (error) {
    row.status = "FAIL"; row.error = error instanceof Error ? error.message : "Unknown evaluation failure";
    throw error;
  } finally { await store.close(); }
}

export function printResults(rows: EvalRow[], mode: "recorded" | "live" = "recorded") {
  console.table(rows.map(row => ({ Scenario: row.scenario, Result: row.status,
    "Recall ms": Math.round(row.recallMs * 100) / 100, "TTFT ms": Math.round(row.ttftMs * 100) / 100,
    "Tool calls": row.toolCalls, Queries: row.searchCount, "Total ms": Math.round(row.totalMs * 100) / 100,
  })));
  console.log("Calendar: 15 November 2026 UTC. Timings exclude database setup and deferred persistence.");
  console.log(mode === "live" ? "Live model requests with synthetic search: one regression sample, not a production accuracy or latency benchmark."
    : "Recorded models and synthetic search measure local plumbing, not provider latency or model accuracy.");
}
