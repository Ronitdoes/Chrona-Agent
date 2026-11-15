"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown, Gauge } from "lucide-react";
import { effortProfiles, effortSchema, type ResearchEffort } from "../lib/research-effort";
import { useSmoothScroll } from "./smooth-scrolling";

export function EffortPicker({ value, disabled, onChange }: { value: ResearchEffort; disabled: boolean; onChange: (effort: ResearchEffort) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  useSmoothScroll(panel, content, open);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus();
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);

  return <div ref={root} className="relative shrink-0" onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false); }}>
    <button ref={trigger} type="button" disabled={disabled} aria-label={`Research effort: ${effortProfiles[value].label}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => setOpen(!open)} className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-50">
      <Gauge size={13} aria-hidden="true" /><span>{effortProfiles[value].label}</span><ChevronDown size={11} aria-hidden="true" />
    </button>
    {open ? <div ref={panel} data-lenis-scroll id={id} role="dialog" aria-label="Research effort" className="chat-scroll absolute left-0 bottom-full z-40 mb-3 max-h-[60dvh] w-[min(270px,calc(100vw-80px))] overflow-y-auto rounded-2xl border border-border bg-surface p-2 shadow-[0_12px_40px_#0004]">
      <div ref={content}>
      <p className="px-3 pt-2 pb-1 text-[10px] font-medium tracking-[0.08em] text-muted uppercase">Research effort</p>
      {effortSchema.options.map(effort => {
        const profile = effortProfiles[effort];
        return <button key={effort} type="button" aria-pressed={effort === value} onClick={() => { onChange(effort); setOpen(false); trigger.current?.focus(); }} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-surface-2">
          <span className="flex-1"><span className="block text-sm">{profile.label}</span><span className="mt-1 block text-[11px] text-muted">{profile.range} sources · up to {profile.maxQueries} searches</span></span>
          {effort === value ? <Check size={16} className="text-accent-ink" aria-hidden="true" /> : null}
        </button>;
      })}
      <p className="px-3 pt-1 pb-2 text-[10px] leading-relaxed text-muted">Source count depends on relevance and availability.</p>
      </div>
    </div> : null}
  </div>;
}
