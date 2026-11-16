"use client";
import { useEffect, useRef, useState } from "react";
import { ChevronDown, Circle, Pin, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import type { HistorySession } from "../lib/history";
import { historyGroups } from "../lib/workspace";
import { useSmoothScroll } from "./smooth-scrolling";

export function HistorySidebar({ sessions, selected, iso, tz, loading, error, hasMore, disabled, pinned = [], onPin, onDelete, onNew, onSelect, onMore, onRetry }: {
  sessions: HistorySession[]; selected: string | null; iso: string; tz: string; loading: boolean; error?: string; hasMore: boolean; disabled: boolean; pinned?: string[];
  onPin?: (id: string) => void; onNew: () => void; onSelect: (id: string) => void; onMore: () => void; onRetry: () => void;
  onDelete?: (session: HistorySession) => void;
}) {
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const viewport = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);
  useSmoothScroll(viewport, content);
  useEffect(() => { if (searching) search.current?.focus(); }, [searching]);
  const filtered = sessions.filter(session => session.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const pinnedSessions = filtered.filter(session => pinned.includes(session.id));
  const groups = historyGroups(filtered.filter(session => !pinned.includes(session.id)), iso, tz);
  const row = (session: HistorySession) => <li key={session.id} className={`group flex items-center rounded-lg ${session.id === selected ? "bg-surface-2" : "hover:bg-surface"}`}>
    <button type="button" data-close-drawer disabled={disabled} onClick={() => onSelect(session.id)} aria-current={session.id === selected ? "page" : undefined}
      className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-2.5 text-left text-xs disabled:opacity-50" title={session.title}>
      <Circle size={5} strokeWidth={1.4} className="shrink-0 text-muted" aria-hidden="true" /><span className="truncate">{session.title || "Untitled conversation"}</span>
    </button>
    {onPin ? <button type="button" disabled={disabled} onClick={() => onPin(session.id)} aria-label={`${pinned.includes(session.id) ? "Unpin" : "Pin"} ${session.title || "conversation"}`} aria-pressed={pinned.includes(session.id)} title={pinned.includes(session.id) ? "Unpin conversation" : "Pin conversation"}
      className={`mr-1 flex size-7 shrink-0 items-center justify-center rounded text-muted hover:text-foreground focus:opacity-100 disabled:opacity-50 ${pinned.includes(session.id) ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"}`}><Pin size={12} aria-hidden="true" /></button> : null}
    {onDelete ? <button type="button" data-close-drawer disabled={disabled} onClick={() => onDelete(session)} aria-label={`Delete conversation: ${session.title || "Untitled conversation"}`} title="Delete conversation"
      className="mr-1 flex size-7 shrink-0 items-center justify-center rounded text-muted opacity-70 hover:text-accent-ink focus:opacity-100 disabled:opacity-40 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"><Trash2 size={13} aria-hidden="true" /></button> : null}
  </li>;
  return <>
    <div className="mt-5 space-y-1">
      <button type="button" data-close-drawer onClick={onNew} disabled={disabled} className="flex w-full items-center gap-2.5 rounded-lg bg-surface-2 px-3 py-2.5 text-sm hover:opacity-85 disabled:opacity-50"><Plus size={18} strokeWidth={1.6} aria-hidden="true" />New chat</button>
      <button type="button" onClick={() => { if (searching) setQuery(""); setSearching(!searching); }} aria-expanded={searching} className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm text-muted hover:bg-surface hover:text-foreground"><Search size={17} strokeWidth={1.6} aria-hidden="true" />Search</button>
      {searching ? <form role="search" onSubmit={event => event.preventDefault()} className="pb-2"><input ref={search} type="search" value={query} onChange={event => setQuery(event.target.value)} aria-label="Search conversations" placeholder="Search conversations…" className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-xs placeholder:text-muted" /></form> : null}
    </div>
    <nav ref={viewport} data-lenis-scroll tabIndex={0} aria-label="Conversation history" aria-busy={loading} className="chat-scroll mt-6 min-h-0 flex-1 overflow-y-auto">
      <div ref={content}>
      <details open className="mb-6"><summary className="mb-2 flex cursor-pointer list-none items-center gap-1.5 px-2 text-xs font-medium">Pinned<ChevronDown size={12} aria-hidden="true" /></summary>
        {pinnedSessions.length ? <ul>{pinnedSessions.map(row)}</ul> : <p className="px-2 py-2 text-[11px] leading-relaxed text-muted">Pin a conversation to keep it close.</p>}
      </details>
      <details open><summary className="mb-3 flex cursor-pointer list-none items-center gap-1.5 px-2 text-xs font-medium">Conversations<ChevronDown size={12} aria-hidden="true" /></summary>
        {groups.map(group => <section key={group.label} className="mb-4" aria-label={group.label}>
          <h2 className="mb-1 px-2 text-[10px] text-muted">{group.label}</h2><ul>{group.sessions.map(row)}</ul>
        </section>)}
        {!filtered.length && !loading && !error ? <p className="px-2 py-2 text-xs leading-relaxed text-muted">{query.trim() ? "No loaded conversations match." : "Your conversations will appear here."}</p> : null}
      </details>
      {loading ? <p role="status" className="px-2 py-2 text-xs text-muted">Loading conversations…</p> : null}
      {error ? <div className="px-2 text-xs leading-relaxed text-muted"><p role="status">{error}</p><button type="button" onClick={onRetry} disabled={loading} className="mt-2 flex items-center gap-1.5 rounded py-1 text-foreground"><RefreshCw size={12} aria-hidden="true" />Retry history</button></div> : null}
      {hasMore ? <button type="button" onClick={onMore} disabled={loading} className="mx-2 mb-3 rounded py-2 text-xs text-muted hover:text-foreground disabled:opacity-50">Load older conversations</button> : null}
      </div>
    </nav>
  </>;
}
