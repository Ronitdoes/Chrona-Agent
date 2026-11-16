"use client";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { z } from "zod";
import { AppShell } from "./app-shell";
import { Chat } from "./chat";
import { HistorySidebar } from "./history-sidebar";
import type { HistorySession } from "../lib/history";
import { historyPageSchema, mergeHistory, sessionMessages } from "../lib/workspace";
import { modelCatalogSchema, modelSelectionSchema, type ModelCatalog, type ModelSelection } from "../lib/model-selection";
import type { ChatMessage } from "../lib/chat-state";
import { DeleteConversationDialog } from "./delete-conversation-dialog";
import { effortSchema, type ResearchEffort } from "../lib/research-effort";

const subscribeOnline = (callback: () => void) => {
  window.addEventListener("online", callback); window.addEventListener("offline", callback);
  return () => { window.removeEventListener("online", callback); window.removeEventListener("offline", callback); };
};
const storeValue = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* Storage may be disabled. */ } };

export function Workspace({ initialClock }: { initialClock: { iso: string; tz: string } }) {
  const [clock, setClock] = useState(initialClock);
  const [sessions, setSessions] = useState<HistorySession[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [revision, setRevision] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false);
  const [historyError, setHistoryError] = useState<string>();
  const [cursor, setCursor] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<ModelCatalog>();
  const [selection, setSelection] = useState<ModelSelection>();
  const [effort, setEffort] = useState<ResearchEffort>("medium");
  const [modelError, setModelError] = useState<string>();
  const [modelsLoading, setModelsLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pinned, setPinned] = useState<string[]>([]);
  const [opening, setOpening] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<HistorySession | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string>();
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
  const historyRequest = useRef<AbortController | null>(null);
  const modelRequest = useRef<AbortController | null>(null);
  const sessionRequest = useRef<AbortController | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deleted = useRef(new Set<string>());

  const loadHistory = useCallback(async (before?: string, restore = false) => {
    historyRequest.current?.abort();
    const controller = new AbortController(); historyRequest.current = controller;
    setHistoryLoading(true); setHistoryLoadingMore(Boolean(before)); setHistoryError(undefined);
    try {
      const query = new URLSearchParams({ limit: "200", tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
      if (before) query.set("before", before);
      const response = await fetch(`/api/history?${query}`, { credentials: "same-origin", signal: controller.signal });
      if (!response.ok) throw new Error("History unavailable");
      const page = historyPageSchema.parse(await response.json());
      if (controller.signal.aborted) return;
      setClock({ iso: page.now, tz: page.tz });
      setSessions(current => mergeHistory(current, page.sessions).filter(session => !deleted.current.has(session.id)));
      setCursor(page.nextCursor);
      if (restore) {
        try { const parsed = z.array(z.uuid()).max(100).safeParse(JSON.parse(localStorage.getItem("web-agent.pinned") ?? "[]")); if (parsed.success) setPinned(parsed.data); } catch { /* Optional storage. */ }
        let stored: string | null = null;
        try { const value = localStorage.getItem("web-agent.session"); if (z.uuid().safeParse(value).success) stored = value; } catch { /* Optional storage. */ }
        const id = stored ?? page.activeSessionId;
        setSessionId(current => current ?? id);
        setMessages(sessionMessages(page.sessions.find(session => session.id === id)));
      }
    } catch {
      if (!controller.signal.aborted) { setHistoryError("Conversation history is unavailable. Your current chat stays here."); setSessionId(current => current ?? crypto.randomUUID()); }
    } finally { if (!controller.signal.aborted) { setHistoryLoading(false); setHistoryLoadingMore(false); } }
  }, []);

  const loadModels = useCallback(async () => {
    modelRequest.current?.abort();
    const controller = new AbortController(); modelRequest.current = controller;
    setModelError(undefined); setModelsLoading(true);
    try {
      const response = await fetch("/api/models", { credentials: "same-origin", signal: controller.signal });
      if (!response.ok) throw new Error("Models unavailable");
      const data = modelCatalogSchema.parse(await response.json());
      if (controller.signal.aborted) return;
      setCatalog(data);
      let saved: ModelSelection | undefined;
      try { const parsed = effortSchema.safeParse(localStorage.getItem("web-agent.effort")); if (parsed.success) setEffort(parsed.data); } catch { /* Optional storage. */ }
      try { const parsed = modelSelectionSchema.safeParse(JSON.parse(localStorage.getItem("web-agent.model") ?? "null")); if (parsed.success) saved = parsed.data; } catch { /* Optional storage. */ }
      setSelection(current => current ?? saved ?? data.default);
    } catch { if (!controller.signal.aborted) setModelError("Model settings could not be loaded."); }
    finally { if (!controller.signal.aborted) setModelsLoading(false); }
  }, []);

  useEffect(() => {
    // Begin after mount; network responses drive state updates, with cancellation
    // for Strict Mode's setup/cleanup cycle and route changes.
    const start = setTimeout(() => { void loadHistory(undefined, true); void loadModels(); }, 0);
    return () => { clearTimeout(start); historyRequest.current?.abort(); modelRequest.current?.abort(); sessionRequest.current?.abort(); if (refreshTimer.current) clearTimeout(refreshTimer.current); };
  }, [loadHistory, loadModels]);

  function newChat() {
    if (busy || opening) return;
    const id = crypto.randomUUID();
    setSessionId(id); setMessages([]); setRevision(value => value + 1); storeValue("web-agent.session", id);
  }
  async function openSession(id: string) {
    if (busy || opening || id === sessionId) return;
    sessionRequest.current?.abort();
    const controller = new AbortController(); sessionRequest.current = controller;
    setOpening(true);
    try {
      const query = new URLSearchParams({ sessionId: id, limit: "200", tz: clock.tz });
      const response = await fetch(`/api/history?${query}`, { credentials: "same-origin", signal: controller.signal });
      if (!response.ok) throw new Error("Unavailable");
      const page = historyPageSchema.parse(await response.json());
      if (controller.signal.aborted) return;
      setSessions(current => mergeHistory(current, page.sessions));
      setMessages(sessionMessages(page.sessions.find(session => session.id === id)));
      setSessionId(id); setRevision(value => value + 1); storeValue("web-agent.session", id);
    } catch { if (!controller.signal.aborted) setHistoryError("That conversation could not be opened. Please try again."); }
    finally { if (!controller.signal.aborted) setOpening(false); }
  }
  function changeModel(value: ModelSelection) {
    setSelection(value);
    if (modelSelectionSchema.safeParse(value).success) storeValue("web-agent.model", JSON.stringify(value));
  }
  function changeEffort(value: ResearchEffort) {
    setEffort(value);
    storeValue("web-agent.effort", value);
  }
  function togglePin(id: string) {
    setPinned(current => { const next = current.includes(id) ? current.filter(item => item !== id) : [...current, id].slice(-100); storeValue("web-agent.pinned", JSON.stringify(next)); return next; });
  }
  async function deleteConversation() {
    if (!pendingDelete || deleting || busy || !online) return;
    const id = pendingDelete.id;
    setDeleting(true); setDeleteError(undefined);
    try {
      const response = await fetch(`/api/history?${new URLSearchParams({ sessionId: id })}`, { method: "DELETE", credentials: "same-origin" });
      if (!response.ok) {
        setDeleteError(response.status === 429 ? "Please wait for the current response or request limit, then try again." : "The conversation could not be deleted. Please try again.");
        return;
      }
      deleted.current.add(id);
      historyRequest.current?.abort(); setHistoryLoading(false); setHistoryLoadingMore(false);
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      setSessions(current => current.filter(session => session.id !== id));
      setPinned(current => { const next = current.filter(item => item !== id); storeValue("web-agent.pinned", JSON.stringify(next)); return next; });
      if (sessionId === id) {
        const next = crypto.randomUUID();
        setSessionId(next); setMessages([]); setRevision(value => value + 1); storeValue("web-agent.session", next);
      }
      setPendingDelete(null);
      requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.focus());
    } catch { setDeleteError("The conversation could not be deleted. Please try again."); }
    finally { setDeleting(false); }
  }
  function sent(text: string) {
    if (!sessionId) return;
    storeValue("web-agent.session", sessionId);
    setSessions(current => current.some(session => session.id === sessionId) ? current : [{ id: sessionId, title: text.slice(0, 80), lastTs: clock.iso, days: [] }, ...current]);
  }
  function complete() {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => { void loadHistory(); }, 600);
  }
  const available = catalog?.providers.find(provider => provider.id === selection?.provider)?.available;
  const validSelection = modelSelectionSchema.safeParse(selection).success;
  const notice = !online ? "You’re offline. Your draft is safe here; reconnect to send it." : modelError
    ?? (catalog ? !available ? `Add ${selection?.provider === "gemini" ? "GEMINI_API_KEY" : "ANTHROPIC_API_KEY"} to your server environment, then restart the app.` : !validSelection ? "Enter a valid model ID." : undefined : undefined);

  return <AppShell sidebar={<HistorySidebar sessions={sessions} selected={sessionId} iso={clock.iso} tz={clock.tz} loading={historyLoading} loadingMore={historyLoadingMore} error={historyError} hasMore={Boolean(cursor)} disabled={busy || opening || deleting} pinned={pinned} onPin={togglePin}
    onDelete={conversation => { setDeleteError(undefined); setPendingDelete(conversation); }}
    onNew={newChat} onSelect={id => { void openSession(id); }} onMore={() => { if (cursor) void loadHistory(cursor); }} onRetry={() => { void loadHistory(undefined, !sessionId); }} />}>
    {modelError ? <button type="button" onClick={() => { void loadModels(); }} className="mb-2 w-fit rounded text-xs text-muted underline">Retry model settings</button> : null}
    <Chat key={`${sessionId}:${revision}`} sessionId={sessionId ?? undefined} initialMessages={messages} selection={selection} catalog={catalog} onSelectionChange={changeModel}
      clock={clock} disabled={!online || !sessionId || opening || !catalog || !available || !validSelection} notice={notice}
      loading={opening || historyLoading && !sessionId} loadingLabel={opening ? "Opening conversation" : "Loading conversation"} modelsLoading={modelsLoading && !catalog}
      onBusyChange={setBusy} onSent={sent} onComplete={complete} effort={effort} onEffortChange={changeEffort} />
    <DeleteConversationDialog conversation={pendingDelete} deleting={deleting} online={online} error={deleteError} tz={clock.tz} onConfirm={() => { void deleteConversation(); }} onCancel={() => { if (!deleting) setPendingDelete(null); }} />
  </AppShell>;
}
