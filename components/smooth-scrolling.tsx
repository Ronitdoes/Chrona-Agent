"use client";

import { useEffect, useRef, type RefObject } from "react";
import Lenis, { type LenisOptions } from "lenis";

const options: LenisOptions = {
  autoRaf: true,
  lerp: 0.12,
  syncTouch: false,
  respectReducedMotion: true,
  allowNestedScroll: true,
  virtualScroll: ({ event }) => !event.shiftKey,
  // Each panel owns its wheel events. Editing controls retain native behavior.
  prevent: (node: HTMLElement) => node.hasAttribute("data-lenis-scroll") || node.matches("textarea, select"),
};

export function SmoothScrolling() {
  useEffect(() => {
    const lenis = new Lenis({ ...options, anchors: true });
    return () => lenis.destroy();
  }, []);
  return null;
}

/** The app uses independent overflow panels rather than a scrolling document. */
export function useSmoothScroll(wrapper: RefObject<HTMLElement | null>, content: RefObject<HTMLElement | null>, enabled = true, orientation: "vertical" | "horizontal" = "vertical") {
  const instance = useRef<Lenis | null>(null);
  useEffect(() => {
    if (!enabled || !wrapper.current || !content.current) return;
    const lenis = new Lenis({ ...options, orientation, gestureOrientation: orientation, wrapper: wrapper.current, content: content.current });
    instance.current = lenis;
    return () => { instance.current = null; lenis.destroy(); };
  }, [wrapper, content, enabled, orientation]);
  return instance;
}
