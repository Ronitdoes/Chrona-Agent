"use client";
import { useEffect, useId, useRef } from "react";
import type { HistorySession } from "../lib/history";
import { dateFrom } from "../lib/clock";
import { useSmoothScroll } from "./smooth-scrolling";

export function DeleteConversationDialog({ conversation, deleting, online, error, tz, onConfirm, onCancel }: {
  conversation: HistorySession | null; deleting: boolean; online: boolean; error?: string; tz: string; onConfirm: () => void; onCancel: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const content = useRef<HTMLDivElement>(null);
  useSmoothScroll(dialog, content, Boolean(conversation));
  const title = useId(); const description = useId();
  useEffect(() => {
    const element = dialog.current;
    if (conversation && !element?.open) element?.showModal();
    else if (!conversation && element?.open) element.close();
  }, [conversation]);
  return <dialog ref={dialog} data-lenis-scroll aria-labelledby={title} aria-describedby={description} onClose={onCancel}
    onCancel={event => { if (deleting) event.preventDefault(); }}
    className="fixed inset-0 m-auto w-[min(90vw,400px)] rounded-2xl border border-border bg-surface p-6 text-foreground shadow-[0_16px_60px_#0005] backdrop:bg-black/45">
    <div ref={content}>
    <h2 id={title} className="font-serif text-2xl tracking-tight">Delete conversation?</h2>
    <p className="mt-4 truncate text-sm font-medium" title={conversation?.title}>{conversation?.title}</p>
    {conversation ? <p className="mt-1 text-[11px] text-muted">Last updated {new Intl.DateTimeFormat("en-GB", { timeZone: tz, dateStyle: "medium", timeStyle: "short" }).format(dateFrom(conversation.lastTs))}</p> : null}
    <p id={description} className="mt-4 text-sm leading-relaxed text-muted">This permanently removes its messages and saved notes. It can’t be undone.</p>
    {error || !online ? <p role="alert" className="mt-3 text-xs leading-relaxed text-muted">{!online ? "Reconnect to delete this conversation." : error}</p> : null}
    <div className="mt-6 flex justify-end gap-2">
      <button type="button" disabled={deleting} onClick={() => dialog.current?.close()} className="rounded-lg border border-border px-4 py-2 text-xs hover:bg-surface-2 disabled:opacity-50">Cancel</button>
      <button type="button" disabled={deleting || !online} onClick={onConfirm} className="rounded-lg bg-accent px-4 py-2 text-xs font-medium text-accent-foreground hover:opacity-85 disabled:opacity-50">{deleting ? "Deleting…" : "Delete conversation"}</button>
    </div>
    </div>
  </dialog>;
}
