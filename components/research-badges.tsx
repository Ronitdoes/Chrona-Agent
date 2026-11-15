import { CalendarDays, Check, CircleHelp, TrendingUp } from "lucide-react";
import { displayDate, verdictLabels, type Verdict } from "../lib/research-ui";

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  const Icon = { changed: TrendingUp, unchanged: Check, unknown: CircleHelp }[verdict];
  return <span className={`verdict-badge verdict-${verdict}`}><Icon size={12} strokeWidth={1.7} aria-hidden="true" />{verdictLabels[verdict]}</span>;
}

export function AsOfChip({ date }: { date: string }) {
  const label = displayDate(date);
  if (!label) return null;
  return <span className="as-of-chip"><CalendarDays size={11} aria-hidden="true" /><time dateTime={date}>As of {label}</time></span>;
}
