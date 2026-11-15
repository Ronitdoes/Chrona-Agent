"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, type FormEvent, type ReactNode } from "react";
import { ArrowUp, Square } from "lucide-react";

export function Composer({ value, busy, onChange, onSend, onStop, disabled = false, modelControls }: {
  value: string; busy: boolean; onChange: (value: string) => void; onSend: () => void; onStop: () => void;
  disabled?: boolean; modelControls?: ReactNode;
}) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const resize = useCallback(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
    element.style.overflowY = element.scrollHeight > 200 ? "auto" : "hidden";
  }, []);
  useLayoutEffect(resize, [value, resize]);
  useEffect(() => {
    const element = textarea.current;
    if (!element) return;
    let previousWidth = element.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const width = element.getBoundingClientRect().width;
      if (width !== previousWidth) { previousWidth = width; resize(); }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [resize]);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!busy && !disabled && value.trim()) onSend();
  }
  return (
    <form onSubmit={submit} className="shrink-0 pt-3" aria-label="Send a message">
      <div className="composer-card relative rounded-2xl border border-border bg-surface shadow-[0_2px_12px_#00000006] focus-within:border-accent">
        <textarea ref={textarea} aria-label="Message" rows={1} maxLength={20_000}
          value={value} onChange={(event) => onChange(event.target.value)} placeholder="Ask a question…"
          className="block min-h-14 w-full resize-none rounded-2xl bg-transparent py-4 pr-16 pl-4 font-sans text-sm leading-6 text-foreground placeholder:text-muted focus:outline-none"
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
            event.preventDefault();
            if (!busy && !disabled) event.currentTarget.form?.requestSubmit();
          }} />
        {modelControls ? <div className="flex min-w-0 items-center gap-2 px-3 pb-3 pr-14">{modelControls}</div> : null}
        <button type={busy ? "button" : "submit"} onClick={busy ? () => { onStop(); textarea.current?.focus(); } : undefined} disabled={!busy && (disabled || !value.trim())}
          aria-label={busy ? "Stop response" : "Send message"} title={busy ? "Stop response" : "Send message"}
          className="absolute right-3 bottom-3 flex size-9 items-center justify-center rounded-full bg-accent text-accent-foreground transition-opacity duration-150 hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-30">
          {busy ? <Square size={13} fill="currentColor" aria-hidden="true" /> : <ArrowUp size={19} strokeWidth={2} aria-hidden="true" />}
        </button>
      </div>
    </form>
  );
}
