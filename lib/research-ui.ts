import { z } from "zod";
import { dateFrom } from "./clock";
import type { AgentEvents, Source } from "./agent/events";
import type { ChatMessage } from "./chat-state";

export type Verdict = "changed" | "unchanged" | "unknown";
export const verdictLabels: Record<Verdict, string> = { changed: "Changed", unchanged: "Unchanged", unknown: "Couldn’t verify" };
export function verdictFromLabel(value: string): Verdict | null {
  const label = value.trim().toLowerCase().replace(/’/g, "'");
  if (label === "changed" || label === "unchanged") return label;
  return label === "couldn't verify" || label === "could not verify" ? "unknown" : null;
}

const day = z.iso.date();
const instant = z.iso.datetime({ offset: true });
const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
export function asOfDate(value: string): string | null {
  const text = value.trim();
  if (day.safeParse(text).success) return text;
  const match = /^(?:(\d{1,2})\s+([a-z]+)\.?\s+(\d{4})|([a-z]+)\.?\s+(\d{1,2}),?\s+(\d{4}))$/i.exec(text);
  if (!match) return null;
  const name = (match[2] ?? match[4]).toLowerCase();
  const month = months.findIndex((month) => month === name || month.slice(0, 3) === name);
  if (month < 0) return null;
  const iso = `${match[3] ?? match[6]}-${String(month + 1).padStart(2, "0")}-${(match[1] ?? match[5]).padStart(2, "0")}`;
  return day.safeParse(iso).success ? iso : null;
}

export function displayDate(value: string | null): string | null {
  if (!value || !day.safeParse(value).success && !instant.safeParse(value).success) return null;
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" }).format(dateFrom(value));
}

export function sourceDetails(source: Source): { url: string; domain: string; favicon: string } | null {
  try {
    const url = new URL(source.url);
    if (!/^(https?:)$/.test(url.protocol) || url.username || url.password) return null;
    // Derive the displayed host from the actual link, not model/provider display text.
    return { url: url.href, domain: url.hostname.replace(/^www\./, ""), favicon: `${url.origin}/favicon.ico` };
  } catch { return null; }
}

export function searchSummary(searches: AgentEvents["status"][], state: ChatMessage["state"]) {
  const pending = searches.some((search) => search.state === "running");
  const phase = !pending ? "done" : state === "streaming" ? "running" : state === "stopped" ? "stopped" : "interrupted";
  const count = searches.reduce((sum, search) => sum + search.queries.length, 0);
  const label = { done: "Searched the web", running: "Searching the web", stopped: "Search stopped", interrupted: "Search incomplete" }[phase];
  return { phase, count, label: `${label} · ${count} ${count === 1 ? "query" : "queries"}` };
}
