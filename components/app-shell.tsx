"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { PanelLeftClose, PanelLeftOpen, X } from "lucide-react";
import { ThemeToggle } from "./theme-toggle";
import Link from "next/link";
import { AppLogo } from "./app-logo";
import { WorkspaceBackground } from "./workspace-background";

export function AppShell({ children, sidebar, sidebarFooter }: { children: ReactNode; sidebar?: ReactNode; sidebarFooter?: ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawer = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => { drawer.current?.close(); setDrawerOpen(false); };
  useEffect(() => {
    const media = matchMedia("(min-width: 768px)");
    const update = () => { if (media.matches) { drawer.current?.close(); setDrawerOpen(false); } };
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const navigation = sidebar ?? <p className="mt-10 text-xs text-muted">Your workspace</p>;
  const brand = <Link href="/" aria-label="Chrona home" className="mx-1 flex w-fit items-center gap-2 rounded-md"><AppLogo size={38} /><span className="text-[17px] font-medium tracking-[-0.04em]">Chrona</span></Link>;
  return <div className="flex h-dvh overflow-hidden">
    <a href="#workspace" className="fixed left-4 top-4 z-50 -translate-y-24 rounded-lg bg-foreground px-4 py-2 text-background focus:translate-y-0">Skip to content</a>
    <aside id="app-sidebar" aria-label="Sidebar" className={`w-(--sidebar-width) shrink-0 flex-col border-r border-border bg-background px-3 py-4 ${sidebarOpen ? "hidden md:flex" : "hidden"}`}>
      <div className="flex items-center justify-between gap-2">{brand}<button type="button" className="icon-button" aria-label="Collapse sidebar" onClick={() => setSidebarOpen(false)}><PanelLeftClose size={17} aria-hidden="true" /></button></div>{navigation}
      {sidebarFooter ? <footer className="mt-auto shrink-0 border-t border-border pt-3">{sidebarFooter}</footer> : null}
    </aside>
    <dialog ref={drawer} aria-label="Conversation navigation" onClose={() => { setDrawerOpen(false); trigger.current?.focus(); }}
      onClick={event => { if (event.target === event.currentTarget || (event.target as Element).closest("[data-close-drawer]")) close(); }}
      className="fixed inset-y-0 left-0 m-0 h-dvh max-h-none w-[min(85vw,280px)] max-w-none border-0 border-r border-border bg-background p-0 text-foreground backdrop:bg-black/40">
      <div className="flex h-full flex-col px-4 py-6"><div className="flex items-center justify-between gap-2">{brand}<button type="button" aria-label="Close navigation" onClick={close} className="icon-button"><X size={18} aria-hidden="true" /></button></div>{navigation}{sidebarFooter ? <footer className="mt-auto shrink-0 border-t border-border pt-3">{sidebarFooter}</footer> : null}</div>
    </dialog>
    <div className="workspace-stage flex min-w-0 flex-1 flex-col">
      <WorkspaceBackground />
      <header className="flex h-20 shrink-0 items-center justify-between gap-3 px-5 md:px-7"><div className="flex min-w-0 items-center gap-3">
        <button ref={trigger} type="button" className="icon-button md:hidden" aria-label="Open navigation" aria-haspopup="dialog" aria-expanded={drawerOpen} onClick={() => { drawer.current?.showModal(); setDrawerOpen(true); }}><PanelLeftOpen size={18} aria-hidden="true" /></button>
        {!sidebarOpen ? <button type="button" className="icon-button hidden md:inline-flex" aria-label="Expand sidebar" aria-controls="app-sidebar" aria-expanded={false} onClick={() => setSidebarOpen(true)}><PanelLeftOpen size={18} aria-hidden="true" /></button> : null}
        <span className="truncate text-[13px] text-muted">Your workspace</span>
      </div><ThemeToggle /></header>
      <main id="workspace" tabIndex={-1} className="flex min-h-0 flex-1 flex-col px-5 focus:outline-none md:px-10"><div className="content-column flex min-h-0 flex-1 flex-col">{children}</div></main>
      <footer className="px-5 py-3 text-center text-[11px] tracking-[0.015em] text-muted">A space for thoughtful questions and well-sourced answers.</footer>
    </div>
  </div>;
}
