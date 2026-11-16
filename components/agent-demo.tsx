"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Play, RotateCcw } from "lucide-react";
import { createDemoRequest, demoMessages, demoSearches, demoSources, type DemoScenario } from "../lib/demo-chat";
import { Chat } from "./chat";
import { MessageList } from "./message-list";
import { SearchStatus } from "./search-status";
import { SourceChips } from "./source-chips";
import { AsOfChip, VerdictBadge } from "./research-badges";
import { useSmoothScroll } from "./smooth-scrolling";
import { ConversationSkeleton, HistoryRowsSkeleton, ModelPickerSkeleton } from "./loading-skeleton";

export function AgentDemo() {
  const [view, setView] = useState<"components" | "stream">("components");
  const [scenario, setScenario] = useState<DemoScenario>("comparison");
  const [replay, setReplay] = useState(0);
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  useSmoothScroll(viewport, content, view === "components");
  const request = useMemo(() => createDemoRequest(scenario), [scenario]);
  const running = [{ ...demoSearches[0], state: "running" as const, count: 0 }];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-border pb-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <span className="rounded-full bg-surface-2 px-2.5 py-1 text-[10px] tracking-[0.08em] text-muted uppercase">Demo · Sample data</span>
          <Link href="/" className="flex items-center gap-1.5 rounded text-xs text-muted hover:text-foreground"><ArrowLeft size={12} aria-hidden="true" />Back to chat</Link>
        </div>
        <h1 className="font-serif text-2xl tracking-tight">Research, at a glance.</h1>
        <p className="mt-1 text-xs leading-relaxed text-muted">No model or search calls. Sample conversations stay in this page.</p>
        <div className="mt-4 flex flex-wrap items-center gap-2" role="group" aria-label="Demo view">
          <button type="button" aria-pressed={view === "components"} onClick={() => setView("components")} className={`rounded-lg border border-border px-3 py-1.5 text-xs ${view === "components" ? "bg-surface-2" : "text-muted"}`}>All component states</button>
          <button type="button" aria-pressed={view === "stream"} onClick={() => setView("stream")} className={`flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs ${view === "stream" ? "bg-surface-2" : "text-muted"}`}><Play size={11} aria-hidden="true" />Stream demo</button>
        </div>
      </div>
      {view === "stream" ? <>
        <div className="flex shrink-0 flex-wrap items-center gap-3 py-3 text-xs">
          <label className="flex items-center gap-2 text-muted">Scenario
            <select aria-label="Demo scenario" className="max-w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-foreground" value={scenario} onChange={(event) => { setScenario(event.target.value as DemoScenario); setReplay((value) => value + 1); }}>
              <option value="comparison">Verified comparison</option><option value="no-results">No results</option><option value="interrupted">Interrupted search</option><option value="slow">Slow reply — try Stop</option>
            </select>
          </label>
          <button type="button" className="ml-auto flex items-center gap-1.5 rounded px-1 py-1 text-muted hover:text-foreground" onClick={() => setReplay((value) => value + 1)}><RotateCcw size={12} aria-hidden="true" />Reset</button>
          <p className="w-full text-[11px] text-muted">Send any message to play this local scenario.</p>
        </div>
        <Chat key={`${scenario}:${replay}`} request={request} localSources />
      </> : <div ref={viewport} data-lenis-scroll className="chat-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain" tabIndex={0} role="region" aria-label="Component examples">
        <div ref={content} className="space-y-9 pt-6 pb-8">
        <section aria-labelledby="demo-loading"><h2 id="demo-loading" className="mb-3 text-sm font-medium">Loading states</h2>
          <p className="mb-4 text-xs leading-relaxed text-muted">History, conversations and model settings use the same placeholders as the workspace. Animation follows your reduced-motion preference.</p>
          <div className="grid gap-6 sm:grid-cols-[180px_1fr]">
            <div className="rounded-xl border border-border p-3"><p className="mb-2 text-[11px] text-muted">History</p><HistoryRowsSkeleton rows={4} /></div>
            <div className="min-w-0"><ConversationSkeleton /><ModelPickerSkeleton /></div>
          </div>
        </section>
        <section aria-labelledby="demo-searches"><h2 id="demo-searches" className="mb-3 text-sm font-medium">Search activity</h2>
          <SearchStatus searches={running} state="streaming" />
          <SearchStatus searches={demoSearches} state="complete" />
          <SearchStatus searches={[{ ...demoSearches[0], count: 0 }]} state="complete" />
          <SearchStatus searches={running} state="stopped" />
          <SearchStatus searches={running} state="error" />
          <p className="text-xs text-muted">Replies that don’t need search show no search activity.</p>
        </section>
        <section aria-labelledby="demo-sources"><h2 id="demo-sources" className="text-sm font-medium">Sources</h2>
          <p className="mt-1 text-xs text-muted">Hover or focus a source for its title and publication date. Escape dismisses the card.</p>
          <SourceChips sources={demoSources} localFavicons />
        </section>
        <section aria-labelledby="demo-verdicts"><h2 id="demo-verdicts" className="mb-3 text-sm font-medium">Verdicts and dates</h2>
          <div className="flex flex-wrap items-center gap-2"><VerdictBadge verdict="changed" /><VerdictBadge verdict="unchanged" /><VerdictBadge verdict="unknown" /><AsOfChip date="2026-11-15" /></div>
          <p className="mt-3 text-xs text-muted">Missing or invalid dates produce no “as of” chip.</p>
        </section>
        <section aria-labelledby="demo-answer"><h2 id="demo-answer" className="border-b border-border pb-3 text-sm font-medium">A complete sample conversation</h2>
          <MessageList messages={demoMessages} busy={false} localSources />
        </section>
        </div>
      </div>}
    </div>
  );
}
