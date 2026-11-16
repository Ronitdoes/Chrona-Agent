"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import Link from "next/link";
import { ChevronUp, KeyRound, LogOut, UserRound } from "lucide-react";
import { authClient } from "../lib/auth-client";
import { useSmoothScroll } from "./smooth-scrolling";

export function AccountMenu() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const focusLast = useRef(false);
  const id = useId();
  useSmoothScroll(panel, content, open);

  useEffect(() => {
    if (!open) return;
    const items =
      panel.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
    const item = focusLast.current ? items?.[items.length - 1] : items?.[0];
    item?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  function handleKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Tab" && open) {
      setOpen(false);
      trigger.current?.focus();
      return;
    }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    if (!open) {
      focusLast.current = event.key === "ArrowUp" || event.key === "End";
      setOpen(true);
      return;
    }
    const items = Array.from(
      panel.current?.querySelectorAll<HTMLElement>(
        '[role="menuitem"]:not(:disabled)',
      ) ?? [],
    );
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (current + (event.key === "ArrowUp" ? -1 : 1) + items.length) %
            items.length;
    items[next]?.focus();
  }

  async function signOut() {
    setBusy(true);
    setError(undefined);
    try {
      const result = await authClient.signOut();
      if (result.error) throw new Error("Sign out failed");
      window.location.replace(new URL("/sign-in", window.location.origin).href);
    } catch {
      setError("Could not sign out. Please try again.");
      setBusy(false);
    }
  }

  return (
    <div
      ref={root}
      className="relative"
      onKeyDown={handleKeys}
      onBlur={(event) => {
        if (
          event.relatedTarget &&
          !event.currentTarget.contains(event.relatedTarget as Node)
        )
          setOpen(false);
      }}
    >
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => {
          focusLast.current = false;
          setOpen(!open);
        }}
        className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent"
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-2">
          <UserRound size={16} strokeWidth={1.6} aria-hidden="true" />
        </span>
        <span className="flex-1">Account</span>
        <ChevronUp
          size={15}
          aria-hidden="true"
          className={`text-muted transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open ? (
        <div
          ref={panel}
          data-lenis-scroll
          id={id}
          role="menu"
          aria-label="Account"
          className="chat-scroll absolute inset-x-0 bottom-full z-50 mb-2 max-h-[60dvh] overflow-y-auto rounded-xl border border-border bg-surface p-1.5 shadow-[0_12px_40px_#0003]"
        >
          <div ref={content}>
            <Link
              role="menuitem"
          tabIndex={-1}
              data-close-drawer
              href="/settings/api-keys"
              onClick={() => setOpen(false)}
              className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm outline-none hover:bg-surface-2 focus:bg-surface-2"
            >
              <KeyRound size={16} strokeWidth={1.6} aria-hidden="true" />
              API keys
            </Link>
            <button
              role="menuitem"
          tabIndex={-1}
              type="button"
              disabled={busy}
              onClick={() => {
                void signOut();
              }}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm outline-none hover:bg-surface-2 focus:bg-surface-2 disabled:opacity-50"
            >
              <LogOut size={16} strokeWidth={1.6} aria-hidden="true" />
              {busy ? "Signing out…" : "Sign out"}
            </button>
            {error ? (
              <p role="alert" className="px-3 py-2 text-xs text-muted">
                {error}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
