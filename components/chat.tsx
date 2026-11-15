"use client";

import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { ArrowDown, BookOpenText } from "lucide-react";
import { chatReducer, type ChatMessage } from "../lib/chat-state";
import { ChatStreamError, requestChat, type ChatEvent } from "../lib/chat-stream";
import { Composer } from "./composer";
import { MessageList } from "./message-list";
import { greeting, starters } from "../lib/workspace";
import type { ModelCatalog, ModelSelection } from "../lib/model-selection";
import { ModelPicker } from "./model-picker";

type ActiveRequest = { id: string; controller: AbortController; flush: () => void; cancelFrame: () => void };

export function Chat({ request = requestChat, localSources = false, initialMessages = [], sessionId, selection, catalog, onSelectionChange,
  clock, disabled = false, notice, onBusyChange, onSent, onComplete }: {
  request?: typeof requestChat; localSources?: boolean; initialMessages?: ChatMessage[]; sessionId?: string;
  selection?: ModelSelection; catalog?: ModelCatalog; onSelectionChange?: (selection: ModelSelection) => void;
  clock?: { iso: string; tz: string }; disabled?: boolean; notice?: string;
  onBusyChange?: (busy: boolean) => void; onSent?: (text: string) => void; onComplete?: () => void;
}) {
  const [state, dispatch] = useReducer(chatReducer, { messages: initialMessages, activeId: null });
  const [draft, setDraft] = useState("");
  const [focusVersion, setFocusVersion] = useState(0);
  const [showJump, setShowJump] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const previousTop = useRef(0);
  const active = useRef<ActiveRequest | null>(null);
  const busy = state.activeId !== null;
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);

  const scrollToLatest = useCallback(() => {
    const element = viewport.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    previousTop.current = element.scrollTop;
  }, []);
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
      await request(text, { signal: controller.signal, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, onEvent, sessionId, selection });
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
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={viewport} tabIndex={0} role="region" aria-label="Messages" className="chat-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1"
        onWheel={(event) => { if (event.deltaY < 0 && event.currentTarget.scrollHeight > event.currentTarget.clientHeight) following.current = false; }}
        onScroll={(event) => {
          const element = event.currentTarget;
          const distance = element.scrollHeight - element.clientHeight - element.scrollTop;
          if (element.scrollTop < previousTop.current - 1) following.current = false;
          else if (distance < 24) following.current = true;
          previousTop.current = element.scrollTop;
          setShowJump(!following.current && distance > 4);
        }}>
        <div ref={content} className={state.messages.length ? "pb-5" : "flex min-h-full flex-col"}>
          {state.messages.length ? <MessageList messages={state.messages} busy={busy} localSources={localSources} onRetry={disabled ? undefined : (text) => { void send(text); }} /> : (
            <section aria-labelledby="workspace-heading" className="flex flex-1 flex-col justify-center py-8 sm:py-12">
              <div className="mb-7 flex size-12 items-center justify-center rounded-2xl border border-border bg-surface">
                <BookOpenText size={26} strokeWidth={1.35} className="text-accent" aria-hidden="true" />
              </div>
              <p className="mb-5 text-[10px] font-medium tracking-[0.18em] text-muted uppercase">Your research, in context</p>
              <h1 id="workspace-heading" className="font-serif text-[clamp(2.25rem,4.2vw,3.25rem)] leading-[1.15] font-normal tracking-[-0.035em] text-balance">
                {clock ? greeting(clock.iso, clock.tz) : "A little context."}<br /><span className="text-muted italic">What’s on your mind?</span>
              </h1>
              <p className="assistant-prose mt-6 max-w-[410px] text-muted">For fresh questions and familiar threads. Explore an idea, revisit a conversation, or check what’s changed.</p>
              <div className="mt-7 flex flex-wrap gap-2" aria-label="Starter questions">{starters.map(starter => <button key={starter.title} type="button" className="rounded-xl border border-border px-3 py-2 text-xs text-muted hover:bg-surface hover:text-foreground" onClick={() => { setDraft(starter.text); setFocusVersion(value => value + 1); }}>{starter.title}</button>)}</div>
            </section>
          )}
        </div>
      </div>
      {showJump ? <button type="button" onClick={() => { following.current = true; scrollToLatest(); setShowJump(false); }}
        className="absolute right-2 bottom-40 z-10 flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-2 text-xs text-foreground shadow-sm"
        aria-label="Jump to latest message"><ArrowDown size={14} aria-hidden="true" />Jump to latest</button> : null}
      {notice ? <p role="status" className="mt-2 text-xs leading-relaxed text-muted">{notice}</p> : null}
      <Composer value={draft} onChange={setDraft} busy={busy} disabled={disabled} focusVersion={focusVersion} onSend={() => { void send(); }} onStop={stop}
        modelControls={catalog && selection && onSelectionChange ? <ModelPicker catalog={catalog} value={selection} onChange={onSelectionChange} disabled={busy} /> : undefined} />
      <span role="status" className="sr-only">{busy ? "Web Agent is responding. Use Stop response to cancel." : ""}</span>
    </div>
  );
}
