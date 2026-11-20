import { ChevronRight, CircleHelp, Globe2, Square } from "lucide-react";
import type { AgentEvents } from "../lib/agent/events";
import type { ChatMessage } from "../lib/chat-state";
import { searchSummary } from "../lib/research-ui";
import { sourceDetails } from "../lib/research-ui";

const stageLabels = {
  searching: "Searching the web", checking: "Checking gaps in the evidence",
  writing: "Writing the answer", visuals: "Preparing visuals",
};

export function SearchStatus({ searches, state, stage }: { searches: AgentEvents["status"][]; state: ChatMessage["state"]; stage?: ChatMessage["researchStage"] }) {
  if (!searches.length && !(stage && state === "streaming")) return null;
  const summary = searchSummary(searches, state);
  const Icon = summary.phase === "stopped" ? Square : summary.phase === "interrupted" ? CircleHelp : Globe2;
  return (
    <details className="search-status group my-4 rounded-xl border border-border font-sans text-xs">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-xl px-3.5 py-3 text-muted hover:text-foreground">
        <Icon size={14} aria-hidden="true" className={summary.phase === "running" ? "search-pulse text-accent" : ""} />
        <span aria-live="polite">{stage && state === "streaming" ? stageLabels[stage] : summary.label}</span>
        {state !== "streaming" && summary.phase === "done" && searches.every((search) => search.count === 0) ? <span className="text-[10px]">· No results</span> : null}
        <ChevronRight size={14} aria-hidden="true" className="ml-auto shrink-0 transition-transform duration-150 group-open:rotate-90" />
      </summary>
      <div className="space-y-4 border-t border-border px-4 py-3">
        {searches.map((search, index) => {
          const running = search.state === "running";
          const status = !running ? search.count ? `${search.count} ${search.count === 1 ? "result" : "results"} across this batch` : "No results returned" : summary.phase === "running" ? "In progress" : "Not completed";
          return (
            <section key={search.id} aria-label={`Search batch ${index + 1}`}>
              <p className="mb-2 flex items-center justify-between gap-3 text-[11px] text-muted"><span>{index === 0 ? "Initial search" : `Follow-up ${index}`}</span><span>{status}</span></p>
              {search.usage?.map(item => <p key={`${item.query}:${item.provider}`} className="mb-2 text-muted">{item.provider === "exa" ? "Exa" : "Tavily"}{item.fallback ? " · fallback" : ""} · {item.query}</p>)}
              <ul className="space-y-2">
                {search.queries.map((query, index) => <li key={`${index}:${query}`} className="flex items-start gap-2 leading-relaxed wrap-anywhere"><span className="mt-1.5 size-1 shrink-0 rounded-full bg-muted" aria-hidden="true" /><span>{query}</span></li>)}
              </ul>
              {search.sources?.length ? <ul className="mt-2 flex flex-wrap gap-2" aria-label="Sources from this search">
                {search.sources.map(source => {
                  const details = sourceDetails(source);
                  return details ? <li key={source.url}><a href={details.url} target="_blank" rel="noopener noreferrer"
                    className="inline-block max-w-56 truncate rounded border border-border px-2 py-1 align-middle hover:text-foreground" title={source.title}>{source.title || details.domain}</a></li> : null;
                })}
              </ul> : null}
            </section>
          );
        })}
      </div>
    </details>
  );
}
