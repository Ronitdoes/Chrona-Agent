"use client";

import { memo } from "react";
import { CircleAlert, Square, RefreshCw } from "lucide-react";
import { AppLogo } from "./app-logo";
import type { ChatMessage } from "../lib/chat-state";
import { MarkdownMessage } from "./markdown-message";
import { SearchStatus } from "./search-status";
import { SourceChips } from "./source-chips";

const Message = memo(function Message({ message, localSources, onRetry }: { message: ChatMessage; localSources: boolean; onRetry?: () => void }) {
  if (message.role === "user") return (
    <article aria-label="Your message" className="ml-auto max-w-[88%] rounded-2xl rounded-br-md bg-surface-2 px-5 py-3.5 font-sans text-sm leading-relaxed whitespace-pre-wrap wrap-anywhere">
      {message.content}
    </article>
  );
  return (
    <article aria-label="Chrona response" className="min-w-0">
      <div className="mb-3 flex items-center gap-2 font-sans text-xs font-medium">
        <AppLogo size={23} />Chrona
      </div>
      <SearchStatus searches={message.searches ?? []} state={message.state} />
      <div className="assistant-prose">
        {message.content ? <MarkdownMessage content={message.content} /> : message.state === "streaming" ? <p className="thinking text-muted">Thinking<span aria-hidden="true">…</span></p> : null}
        {message.state === "streaming" && message.content ? <span className="streaming-caret" aria-hidden="true" /> : null}
      </div>
      <SourceChips sources={message.sources ?? []} localFavicons={localSources} />
      {message.state === "stopped" ? <p className="mt-3 flex items-center gap-1.5 text-xs text-muted"><Square size={10} aria-hidden="true" />Response stopped</p> : null}
      {message.error ? <p role="alert" className="mt-3 flex items-start gap-2 rounded-lg border border-border px-3 py-2.5 text-xs leading-relaxed text-muted"><CircleAlert size={15} className="mt-0.5 shrink-0" aria-hidden="true" />{message.error}</p> : null}
      {message.error && onRetry ? <button type="button" onClick={onRetry} className="mt-2 flex items-center gap-1.5 rounded py-1 text-xs text-muted hover:text-foreground"><RefreshCw size={12} aria-hidden="true" />Retry response</button> : null}
    </article>
  );
});

export function MessageList({ messages, busy, localSources = false, onRetry }: { messages: ChatMessage[]; busy: boolean; localSources?: boolean; onRetry?: (text: string) => void }) {
  return (
    <div role="log" aria-label="Conversation" aria-live="polite" aria-relevant="additions text" aria-busy={busy} className="flex flex-col gap-8 py-5">
      {messages.map((message, index) => <Message key={message.id} message={message} localSources={localSources}
        onRetry={!busy && onRetry && message.role === "assistant" && messages[index - 1]?.role === "user" ? () => onRetry(messages[index - 1].content) : undefined} />)}
    </div>
  );
}
