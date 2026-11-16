"use client";
import { answerDetailSchema, type AnswerDetail } from "../lib/answer-detail";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { AccountMenu } from "./account-menu";
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

export function Workspace({ initialClock, userId }: { userId: string; initialClock: { iso: string; tz: string } }) {
  const pathname = usePathname();
  const router = useRouter();
  const [keys, setKeys] = useState<Record<string, boolean>>({});
  const [searchProvider, setSearchProvider] = useState<"tavily" | "exa">("tavily");
  const [clock, setClock] = useState(initialClock);
  const [sessions, setSessions] = useState<HistorySession[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(() => pathname.startsWith("/chat/") ? pathname.split("/")[2] : null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [revision, setRevision] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false);
  const [historyError, setHistoryError] = useState<string>();
  const [cursor, setCursor] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<ModelCatalog>();
  const [selection, setSelection] = useState<ModelSelection>();
  const [answerDetail, setAnswerDetail] = useState<AnswerDetail>("auto");
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
        try { const parsed = z.array(z.uuid()).max(100).safeParse(JSON.parse(localStorage.getItem(`web-agent.${userId}.pinned`) ?? "[]")); if (parsed.success) setPinned(parsed.data); } catch { /* Optional storage. */ }

      }
    } catch {
      if (!controller.signal.aborted) { setHistoryError("Conversation history is unavailable. Your current chat stays here."); }
    } finally { if (!controller.signal.aborted) { setHistoryLoading(false); setHistoryLoadingMore(false); } }
  }, [userId]);

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
      const keyResponse = await fetch("/api/credentials", { signal: controller.signal });
      if (!keyResponse.ok) throw new Error("Keys unavailable");
      const configured = await keyResponse.json() as Record<string, boolean>;
      if (controller.signal.aborted) return;
      setKeys(configured);
      let preferred: string | null = null;
      try { preferred = localStorage.getItem(`web-agent.${userId}.search`); } catch { /* Optional storage. */ }
      setSearchProvider(preferred === "exa" && configured.exa ? "exa" : configured.tavily ? "tavily" : "exa");
      let saved: ModelSelection | undefined;
      try { const parsed = answerDetailSchema.safeParse(localStorage.getItem(`web-agent.${userId}.answer-detail`)); if (parsed.success) setAnswerDetail(parsed.data); } catch { /* Optional storage. */ }
      try { const parsed = effortSchema.safeParse(localStorage.getItem(`web-agent.${userId}.effort`)); if (parsed.success) setEffort(parsed.data); } catch { /* Optional storage. */ }
      try { const parsed = modelSelectionSchema.safeParse(JSON.parse(localStorage.getItem(`web-agent.${userId}.model`) ?? "null")); if (parsed.success) saved = parsed.data; } catch { /* Optional storage. */ }
      setSelection(current => current ?? (saved && data.providers.some(provider => provider.id === saved.provider && provider.available) ? saved : undefined) ?? data.default);
    } catch { if (!controller.signal.aborted) setModelError("Model settings could not be loaded."); }
    finally { if (!controller.signal.aborted) setModelsLoading(false); }
  }, [userId]);

  useEffect(() => {
    // Begin after mount; network responses drive state updates, with cancellation
    // for Strict Mode's setup/cleanup cycle and route changes.
    const start = setTimeout(() => { void loadHistory(undefined, true); void loadModels(); }, 0);
    return () => { clearTimeout(start); historyRequest.current?.abort(); modelRequest.current?.abort(); sessionRequest.current?.abort(); if (refreshTimer.current) clearTimeout(refreshTimer.current); };
  }, [loadHistory, loadModels]);

  function newChat() {
    if (busy || opening) return;
    setSessionId(null); setMessages([]); setRevision(value => value + 1); router.push("/");
  }
  async function openSession(id: string) {
    if (id === sessionId && messages.length) return;
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
      setSessionId(id); setRevision(value => value + 1);
    } catch { if (!controller.signal.aborted) setHistoryError("That conversation could not be opened. Please try again."); }
    finally { if (!controller.signal.aborted) setOpening(false); }
  }
  function changeModel(value: ModelSelection) {
    setSelection(value);
    if (modelSelectionSchema.safeParse(value).success) storeValue(`web-agent.${userId}.model`, JSON.stringify(value));
  }
  function changeEffort(value: ResearchEffort) {
    setEffort(value);
    storeValue(`web-agent.${userId}.effort`, value);
  }
  function togglePin(id: string) {
    setPinned(current => { const next = current.includes(id) ? current.filter(item => item !== id) : [...current, id].slice(-100); storeValue(`web-agent.${userId}.pinned`, JSON.stringify(next)); return next; });
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
      setPinned(current => { const next = current.filter(item => item !== id); storeValue(`web-agent.${userId}.pinned`, JSON.stringify(next)); return next; });
      if (sessionId === id) {
        setSessionId(null); setMessages([]); setRevision(value => value + 1); router.push("/");
      }
      setPendingDelete(null);
      requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.focus());
    } catch { setDeleteError("The conversation could not be deleted. Please try again."); }
    finally { setDeleting(false); }
  }
  function sent(text: string) {
    if (!sessionId) return;

    setSessions(current => current.some(session => session.id === sessionId) ? current : [{ id: sessionId, title: text.slice(0, 80), lastTs: clock.iso, days: [] }, ...current]);
  }
  function complete() {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => { void loadHistory(); }, 600);
  }
  const available = catalog?.providers.find(provider => provider.id === selection?.provider)?.available;
  const validSelection = modelSelectionSchema.safeParse(selection).success;
  const notice = !online ? "You’re offline. Your draft is safe here; reconnect to send it." : modelError
    ?? (catalog ? !available ? "Add an LLM key in API keys settings." : !validSelection ? "Enter a valid model ID." : undefined : undefined);

  useEffect(() => {
    const timer = setTimeout(() => {
      const id = pathname.startsWith("/chat/") ? pathname.split("/")[2] : null;
      if (id === sessionId) return;
      setRevision(value => value + 1);
      if (id) { void openSession(id); }
      else { sessionRequest.current?.abort(); setSessionId(null); setMessages([]); }
    }, 0);
    return () => clearTimeout(timer);
  // Navigation owns conversation loading. First-send URL updates keep the active stream.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);
  useEffect(() => {
    const timer = setTimeout(() => { if (sessionId) { void openSession(sessionId); } }, 0);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  function created(id: string) { setSessionId(id); window.history.pushState(null, "", `/chat/${id}`); }
  return <AppShell sidebarFooter={<AccountMenu />} sidebar={<HistorySidebar sessions={sessions} selected={sessionId} iso={clock.iso} tz={clock.tz} loading={historyLoading} loadingMore={historyLoadingMore} error={historyError} hasMore={Boolean(cursor)} disabled={busy || opening || deleting} pinned={pinned} onPin={togglePin}
    onDelete={conversation => { setDeleteError(undefined); setPendingDelete(conversation); }}
    onNew={newChat} onSelect={id => { router.push(`/chat/${id}`); }} onMore={() => { if (cursor) void loadHistory(cursor); }} onRetry={() => { void loadHistory(undefined, !sessionId); }} />}>
    {(!available || !keys[searchProvider]) && !modelsLoading ? <p className="mb-2 text-sm text-muted">Connect an LLM key and a search key in <Link href="/settings/api-keys" className="underline">API keys settings</Link> to send messages.</p> : null}
    {modelError ? <button type="button" onClick={() => { void loadModels(); }} className="mb-2 w-fit rounded text-xs text-muted underline">Retry model settings</button> : null}
    <Chat key={revision} sessionId={sessionId ?? undefined} initialMessages={messages} selection={selection} catalog={catalog} onSelectionChange={changeModel}
      clock={clock} disabled={!online || opening || !catalog || !available || !validSelection || !keys[searchProvider]} notice={notice}
      loading={opening} loadingLabel={opening ? "Opening conversation" : "Loading conversation"} modelsLoading={modelsLoading && !catalog}
      searchProvider={searchProvider} searchKeys={keys} onSearchProviderChange={value => { setSearchProvider(value); storeValue(`web-agent.${userId}.search`, value); }} onSession={created} onBusyChange={setBusy} onSent={sent} onComplete={complete} effort={effort} onEffortChange={changeEffort} answerDetail={answerDetail} onAnswerDetailChange={value => { setAnswerDetail(value); storeValue(`web-agent.${userId}.answer-detail`, value); }} />
    <DeleteConversationDialog conversation={pendingDelete} deleting={deleting} online={online} error={deleteError} tz={clock.tz} onConfirm={() => { void deleteConversation(); }} onCancel={() => { if (!deleting) setPendingDelete(null); }} />
  </AppShell>;
}
