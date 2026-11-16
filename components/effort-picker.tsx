"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, Gauge } from "lucide-react";
import { answerDetailProfiles, answerDetailSchema, type AnswerDetail } from "../lib/answer-detail";
import { effortProfiles, effortSchema, type ResearchEffort } from "../lib/research-effort";

type Props = {
  value: ResearchEffort;
  disabled: boolean;
  onChange: (effort: ResearchEffort) => void;
  answerDetail?: AnswerDetail;
  onAnswerDetailChange?: (detail: AnswerDetail) => void;
  searchProvider?: "tavily" | "exa";
  searchKeys?: Record<string, boolean>;
  onSearchProviderChange?: (provider: "tavily" | "exa") => void;
};

const choices = "grid gap-1 rounded-lg bg-surface-2 p-1";
const choice = "min-h-8 rounded-md px-2 text-xs text-muted transition-colors hover:text-foreground aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-sm disabled:opacity-40 motion-reduce:transition-none";
const label = "mb-1.5 text-[11px] font-medium text-muted";

export function EffortPicker({ value, disabled, onChange, searchProvider, searchKeys, onSearchProviderChange, answerDetail = "auto", onAnswerDetailChange }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]:not(:disabled)')?.focus();
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return <div ref={root} className="relative shrink-0" onBlur={event => {
    if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false);
  }}>
    <button ref={trigger} type="button" disabled={disabled}
      aria-label={`Research effort: ${effortProfiles[value].label}${answerDetail !== "auto" ? ` · ${answerDetailProfiles[answerDetail].label}` : ""}`}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => setOpen(!open)}
      className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-50">
      <Gauge size={13} aria-hidden="true" />
      <span>{effortProfiles[value].label}{answerDetail !== "auto" ? ` · ${answerDetailProfiles[answerDetail].label}` : ""}</span>
      <ChevronDown size={11} aria-hidden="true" />
    </button>
    {open ? <div ref={panel} id={id} role="dialog" aria-label="Research effort"
      className="effort-panel absolute bottom-full left-0 z-40 mb-3 w-[min(300px,calc(100vw-48px))] flex flex-col gap-3 rounded-xl border border-border bg-surface p-3 shadow-[0_12px_40px_#0004]">
      {onSearchProviderChange ? <div role="group" aria-label="Search provider">
        <div className="mb-1.5 flex items-center justify-between gap-3">
          <p className="text-[11px] font-medium text-muted">Search provider</p>
          <a href="/settings/api-keys" className="rounded text-[11px] text-muted underline underline-offset-2 hover:text-foreground">API keys</a>
        </div>
        <div className={`${choices} grid-cols-2`}>
          {(["tavily", "exa"] as const).map(provider => <button key={provider} type="button"
            disabled={!searchKeys?.[provider]} aria-pressed={searchProvider === provider}
            title={searchKeys?.[provider] ? undefined : `Add a ${provider === "tavily" ? "Tavily" : "Exa"} key in API keys settings`}
            onClick={() => onSearchProviderChange(provider)} className={choice}>
            {provider === "tavily" ? "Tavily" : "Exa"}
          </button>)}
        </div>
        {searchKeys?.tavily && searchKeys?.exa ? <p className="mt-1.5 text-[10px] text-muted">Uses the other provider on failure.</p> : null}
      </div> : null}
      {onAnswerDetailChange ? <div role="group" aria-label="Answer detail">
        <p className={label}>Answer detail</p>
        <div className={`${choices} grid-cols-3`}>
          {answerDetailSchema.options.map(detail => <button key={detail} type="button"
            aria-pressed={answerDetail === detail} title={`${answerDetailProfiles[detail].description}. Your prompt can override this preference.`}
            onClick={() => onAnswerDetailChange(detail)} className={choice}>
            {answerDetailProfiles[detail].label}
          </button>)}
        </div>
      </div> : null}
      <div role="group" aria-label="Research effort">
        <p className={label}>Research effort</p>
        <div className={`${choices} grid-cols-3`}>
          {effortSchema.options.map(effort => <button key={effort} type="button" aria-pressed={effort === value}
            title={`${effortProfiles[effort].range} sources, up to ${effortProfiles[effort].maxQueries} searches`}
            onClick={() => { onChange(effort); setOpen(false); trigger.current?.focus(); }} className={choice}>
            {effortProfiles[effort].label}
          </button>)}
        </div>
        <p className="mt-1.5 text-[10px] text-muted">Up to {effortProfiles[value].maxQueries} searches · {effortProfiles[value].maxSources} sources</p>
      </div>
    </div> : null}
  </div>;
}
