import { dateFrom, type Clock } from "../lib/clock";

const instant = dateFrom("2026-11-15T12:00:00Z");
export const evalClock: Clock = { instant, iso: instant.toISOString(), human: "Sunday 15 November 2026, 12:00 (UTC)", tz: "UTC" };
export const evalUser = "11111111-1111-4111-8111-111111111113";
export type Item = { subject: string; old: string; current: string; published: string | null; verdict: "changed" | "unchanged" | "unknown"; url: string };
export type Scenario = {
  id: string; message: string; original: string; answer: string; dateText: string; date: string;
  queries: string[]; items: Item[]; depth: "basic" | "deep";
};
const item = (subject: string, old: string, current: string, verdict: Item["verdict"], dated = true): Item => ({
  subject, old, current, verdict, published: dated ? "2026-11-14T10:00:00Z" : null,
  url: `https://example.com/eval/${subject.toLowerCase()}`,
});

// Fictional prices and providers. No statement here describes a current offering.
export const scenarios: Scenario[] = [
  { id: "Monday CRM", message: "On Monday we shortlisted 5 CRM tools. Has any changed pricing or shipped something big since?",
    original: "Shortlist five CRM tools: CedarCRM, MapleCRM, BirchCRM, ElmCRM and AshCRM.",
    answer: "CedarCRM costs $20/month; MapleCRM $30/month; BirchCRM $40/month; ElmCRM $50/month; AshCRM $60/month.",
    dateText: "Monday", date: "2026-11-09", depth: "basic", queries: ["CedarCRM pricing", "MapleCRM pricing", "BirchCRM pricing", "ElmCRM pricing", "AshCRM pricing"],
    items: [item("CedarCRM", "$20/month", "$25/month", "changed"), item("MapleCRM", "$30/month", "$30/month", "unchanged"),
      item("BirchCRM", "$40/month", "$40/month", "unknown", false), item("ElmCRM", "$50/month", "$55/month", "changed"), item("AshCRM", "$60/month", "$60/month", "unchanged")] },
  { id: "3 November answer", message: "What did I ask you on 3 November? Is your answer still correct today?",
    original: "What is the monthly price of AcornCloud?", answer: "AcornCloud costs $10/month.",
    dateText: "3 November", date: "2026-11-03", depth: "basic", queries: ["AcornCloud pricing"], items: [item("AcornCloud", "$10/month", "$12/month", "changed")] },
  { id: "Tuesday Postgres", message: "Last Tuesday I asked about Postgres hosting. Has any pricing changed since then?",
    original: "Compare Postgres hosting from AlphaPG and BetaPG.", answer: "AlphaPG costs $10/month; BetaPG costs $15/month.",
    dateText: "Last Tuesday", date: "2026-11-10", depth: "deep", queries: ["AlphaPG pricing", "BetaPG pricing"],
    items: [item("AlphaPG", "$10/month", "$12/month", "changed"), item("BetaPG", "$15/month", "$15/month", "unknown", false)] },
];

export function recordedAnswer(scenario: Scenario): string {
  return `Historical baseline: ${scenario.date}. Checked on 15 November 2026. These are synthetic evaluation results.\n\n` +
    "| Item | Old value | New value | Verdict | Source date | Source |\n|---|---|---|---|---|---|\n" +
    scenario.items.map(item => `| ${item.subject} | ${item.old} | ${item.current} | ${item.verdict === "unknown" ? "couldn't verify" : item.verdict} | ${item.published ? "14 November 2026" : "undated; current value unverified"} | [Source](${item.url}) |`).join("\n");
}
