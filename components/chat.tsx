"use client";

import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import { chatReducer, type ChatMessage } from "../lib/chat-state";
import { ChatStreamError, requestChat, type ChatEvent } from "../lib/chat-stream";
import { Composer } from "./composer";
import { MessageList } from "./message-list";
import { greeting } from "../lib/workspace";
import type { ModelCatalog, ModelSelection } from "../lib/model-selection";
import { ModelPicker } from "./model-picker";
import { EffortPicker } from "./effort-picker";
import type { ResearchEffort } from "../lib/research-effort";
import { useSmoothScroll } from "./smooth-scrolling";
import { ConversationSkeleton, ModelPickerSkeleton } from "./loading-skeleton";

type ActiveRequest = { id: string; controller: AbortController; flush: () => void; cancelFrame: () => void };

export function Chat({ request = requestChat, localSources = false, initialMessages = [], sessionId, selection, catalog, onSelectionChange,
  clock, disabled = false, notice, onBusyChange, onSent, onComplete, effort = "medium", onEffortChange,
  loading = false, loadingLabel, modelsLoading = false }: {
  request?: typeof requestChat; localSources?: boolean; initialMessages?: ChatMessage[]; sessionId?: string;
  selection?: ModelSelection; catalog?: ModelCatalog; onSelectionChange?: (selection: ModelSelection) => void;
  clock?: { iso: string; tz: string }; disabled?: boolean; notice?: string;
  onBusyChange?: (busy: boolean) => void; onSent?: (text: string) => void; onComplete?: () => void;
  effort?: ResearchEffort; onEffortChange?: (effort: ResearchEffort) => void;
  loading?: boolean; loadingLabel?: string; modelsLoading?: boolean;
}) {
  const [state, dispatch] = useReducer(chatReducer, { messages: initialMessages, activeId: null });
  const [draft, setDraft] = useState("");
  const [showJump, setShowJump] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const smoothScroll = useSmoothScroll(viewport, content);
  const following = useRef(true);
  const previousTop = useRef(0);
  const active = useRef<ActiveRequest | null>(null);
  const busy = state.activeId !== null;
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);

  const scrollToLatest = useCallback((animate = false) => {
    const element = viewport.current;
    if (!element) return;
    if (smoothScroll.current) {
      smoothScroll.current.resize();
      smoothScroll.current.scrollTo("bottom", { immediate: !animate });
    } else element.scrollTop = element.scrollHeight;
    previousTop.current = element.scrollTop;
  }, [smoothScroll]);
  useLayoutEffect(() => { if (following.current) scrollToLatest(); }, [state.messages, scrollToLatest]);
  useEffect(() => {
    const observer = new ResizeObserver(() => { if (following.current) scrollToLatest(); });
    if (content.current) observer.observe(content.current);
    if (viewport.current) observer.observe(viewport.current);
    return () => observer.disconnect();
  }, [scrollToLatest]);
  useEffect(() => () => {
    const request = active.current;
    active.current = null;
    request?.cancelFrame();
    request?.controller.abort();
  }, []);

  function stop() {
    const request = active.current;
    if (!request) return;
    request.flush();
    request.controller.abort();
    active.current = null;
    dispatch({ type: "finish", assistantId: request.id, outcome: "stopped" });
  }

  async function send(retryText?: string) {
    const text = (retryText ?? draft).trim();
    if (!text || active.current || disabled) return;
    const id = crypto.randomUUID();
    const controller = new AbortController();
    let buffer = "";
    let frame: number | null = null;
    const cancelFrame = () => { if (frame !== null) cancelAnimationFrame(frame); frame = null; };
    const flush = () => {
      cancelFrame();
      if (buffer && active.current?.id === id) dispatch({ type: "event", assistantId: id, event: { type: "delta", data: { text: buffer } } });
      buffer = "";
    };
    active.current = { id, controller, flush, cancelFrame };
    following.current = true;
    setShowJump(false);
    setDraft("");
    dispatch({ type: "start", userId: crypto.randomUUID(), assistantId: id, text });
    onSent?.(text);
    const onEvent = (event: ChatEvent) => {
      if (active.current?.id !== id || controller.signal.aborted) return;
      if (event.type === "delta") {
        buffer += event.data.text;
        frame ??= requestAnimationFrame(flush);
      } else {
        flush();
        dispatch({ type: "event", assistantId: id, event });
      }
    };
    try {
      await request(text, { signal: controller.signal, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, onEvent, sessionId, selection, effort });
      flush();
      if (active.current?.id === id) dispatch({ type: "finish", assistantId: id, outcome: "complete" });
    } catch (error) {
      flush();
      if (active.current?.id === id) dispatch({ type: "finish", assistantId: id,
        outcome: controller.signal.aborted ? "stopped" : "error",
        error: controller.signal.aborted ? undefined : error instanceof ChatStreamError ? error.message : "The connection was interrupted. Any text received has been kept. Please try again.",
      });
    } finally {
      cancelFrame();
      if (active.current?.id === id) active.current = null;
      onComplete?.();
    }
  }

  return (
    <div className={`relative flex min-h-0 flex-1 flex-col ${state.messages.length || loading ? "" : "justify-center"}`}>
      <div className="relative min-h-0" style={{ flex: state.messages.length || loading ? "1 1 0%" : "0 1 auto" }}>
      <div ref={viewport} data-lenis-scroll tabIndex={loading ? -1 : 0} role="region" aria-label="Messages" aria-busy={loading} inert={loading}
        className="chat-scroll h-full min-h-0 overflow-y-auto overscroll-contain" style={{ visibility: loading ? "hidden" : undefined }}
        onWheel={(event) => { if (event.deltaY < 0 && event.currentTarget.scrollHeight > event.currentTarget.clientHeight) following.current = false; }}
        onScroll={(event) => {
          const element = event.currentTarget;
          const distance = element.scrollHeight - element.clientHeight - element.scrollTop;
          if (element.scrollTop < previousTop.current - 1) following.current = false;
          else if (distance < 24) following.current = true;
          previousTop.current = element.scrollTop;
          setShowJump(!following.current && distance > 4);
        }}>
        <div ref={content} className={state.messages.length ? "pb-5" : ""}>
          {state.messages.length ? <MessageList messages={state.messages} busy={busy} localSources={localSources} onRetry={disabled ? undefined : (text) => { void send(text); }} /> : (
            <section aria-labelledby="workspace-heading" className="flex flex-col py-4 sm:py-6">
              <p className="mb-4 text-[10px] font-medium tracking-[0.18em] text-muted uppercase">Your research, in context</p>
              <h1 id="workspace-heading" className="font-serif text-[clamp(2.25rem,4.2vw,3.25rem)] leading-[1.15] font-normal tracking-[-0.035em] text-balance">
                {clock ? greeting(clock.iso, clock.tz) : "A little context."}<br /><span className="text-muted italic">What’s on your mind?</span>
              </h1>
              <p className="mt-5 text-sm leading-relaxed text-muted">Ask a fresh question, revisit a conversation, or check what’s changed.</p>
            </section>
          )}
        </div>
      </div>
      {loading ? <div className="absolute inset-0 overflow-hidden"><ConversationSkeleton label={loadingLabel} /></div> : null}
      </div>
      {showJump && !loading ? <button type="button" onClick={() => { following.current = true; scrollToLatest(true); setShowJump(false); }}
        className="absolute right-2 bottom-40 z-10 flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-2 text-xs text-foreground shadow-sm"
        aria-label="Jump to latest message"><ArrowDown size={14} aria-hidden="true" />Jump to latest</button> : null}
      {notice ? <p role="status" className="mt-2 text-xs leading-relaxed text-muted">{notice}</p> : null}
      <Composer value={draft} onChange={setDraft} busy={busy} disabled={disabled} onSend={() => { void send(); }} onStop={stop}
        modelControls={onEffortChange || modelsLoading || (catalog && selection && onSelectionChange) ? <>
          {onEffortChange ? <EffortPicker value={effort} onChange={onEffortChange} disabled={busy || modelsLoading} /> : null}
          {modelsLoading ? <ModelPickerSkeleton /> : catalog && selection && onSelectionChange ? <ModelPicker catalog={catalog} value={selection} onChange={onSelectionChange} disabled={busy} /> : null}
        </> : undefined} />
      <span role="status" className="sr-only">{busy ? "Chrona is responding. Use Stop response to cancel." : ""}</span>
    </div>
  );
}
