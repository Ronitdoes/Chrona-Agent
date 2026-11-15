"use client";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, SlidersHorizontal } from "lucide-react";
import { modelSelectionSchema, providerNames, type ModelCatalog, type ModelSelection } from "../lib/model-selection";

const descriptions = { anthropic: "Careful reasoning and detailed research", gemini: "Lightweight answers through Google AI Studio" };
export function ModelPicker({ catalog, value, disabled, onChange }: { catalog: ModelCatalog; value: ModelSelection; disabled: boolean; onChange: (value: ModelSelection) => void }) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  const [draft, setDraft] = useState(value);
  const selected = catalog.providers.find(provider => provider.id === value.provider)?.models.find(model => model.id === value.model);
  useLayoutEffect(() => {
    if (!open) return;
    const fit = () => { if (panel.current && root.current) panel.current.style.maxHeight = `${Math.max(100, Math.min(innerHeight * 0.7, root.current.getBoundingClientRect().top - 20))}px`; };
    fit(); window.addEventListener("resize", fit);
    const observer = new ResizeObserver(fit);
    if (root.current?.closest("form")) observer.observe(root.current.closest("form")!);
    return () => { window.removeEventListener("resize", fit); observer.disconnect(); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')?.focus();
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); setOpen(false); trigger.current?.focus(); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);
  function choose(selection: ModelSelection) { onChange(selection); setOpen(false); trigger.current?.focus(); }
  return <div ref={root} className="relative ml-auto min-w-0" onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false); }}>
    <button ref={trigger} type="button" aria-label={`Choose model: ${selected?.name ?? value.model}`} aria-haspopup="dialog" aria-controls={open ? id : undefined} aria-expanded={open} disabled={disabled}
      onClick={() => { setDraft(value); setCustom(false); setOpen(!open); }}
      className="flex max-w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-muted transition-colors hover:bg-surface-2 hover:text-foreground disabled:opacity-50">
      <span className="max-w-52 truncate text-foreground">{selected?.name ?? value.model}</span><ChevronDown size={13} aria-hidden="true" />
    </button>
    {open ? <div ref={panel} id={id} role="dialog" aria-label="Choose AI model" className="chat-scroll absolute right-0 bottom-full z-40 mb-3 max-h-[min(70dvh,480px)] w-[min(350px,calc(100vw-80px))] overflow-y-auto rounded-2xl border border-border bg-surface p-2 shadow-[0_12px_40px_#0004]">
      {catalog.providers.map(provider => <section key={provider.id} aria-label={providerNames[provider.id]}>
        <p className="px-3 pt-3 pb-1 text-[10px] font-medium tracking-[0.08em] text-muted uppercase">{providerNames[provider.id]}</p>
        {[...provider.models, ...(provider.id === value.provider && !provider.models.some(model => model.id === value.model) ? [{ id: value.model, name: value.model }] : [])].map(model => <button key={model.id} type="button" aria-pressed={provider.id === value.provider && model.id === value.model} onClick={() => choose({ provider: provider.id, model: model.id })}
          className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-surface-2">
          <span className="min-w-0 flex-1"><span className="block truncate text-sm">{model.name}</span><span className="mt-1 block text-[11px] leading-relaxed text-muted">{provider.available ? descriptions[provider.id] : "Add your API key to enable"}</span></span>
          {provider.id === value.provider && model.id === value.model ? <Check size={17} className="shrink-0 text-accent-ink" aria-hidden="true" /> : null}
        </button>)}
      </section>)}
      <div className="mx-3 mt-2 border-t border-border" />
      <button type="button" aria-expanded={custom} onClick={() => setCustom(!custom)} className="flex w-full items-center gap-2 rounded-xl px-3 py-3 text-left text-xs hover:bg-surface-2"><SlidersHorizontal size={14} aria-hidden="true" />More models<ChevronRight size={14} className="ml-auto" aria-hidden="true" /></button>
      {custom ? <div className="space-y-3 px-3 pt-1 pb-3">
        <label className="block text-[11px] text-muted">Provider<select aria-label="Custom model provider" value={draft.provider} onChange={event => { const provider = catalog.providers.find(provider => provider.id === event.target.value)!; setDraft({ provider: provider.id, model: provider.models[0].id }); }} className="mt-1.5 block w-full rounded-lg border border-border bg-background px-2 py-2 text-xs text-foreground">{catalog.providers.map(provider => <option key={provider.id} value={provider.id}>{providerNames[provider.id]}</option>)}</select></label>
        <label className="block text-[11px] text-muted">Model ID<input aria-label="Custom model ID" value={draft.model} onChange={event => setDraft({ ...draft, model: event.target.value })} maxLength={120} autoComplete="off" spellCheck={false} className="mt-1.5 block w-full rounded-lg border border-border bg-background px-2 py-2 text-xs text-foreground" /></label>
        <button type="button" disabled={!modelSelectionSchema.safeParse(draft).success} onClick={() => choose(draft)} className="rounded-lg bg-surface-2 px-3 py-2 text-xs disabled:opacity-50">Use model</button>
      </div> : null}
    </div> : null}
  </div>;
}
