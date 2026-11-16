"use client";

import { memo, useEffect, useId, useMemo, useRef, useState } from "react";
import { asciiBackgroundRows } from "../lib/ascii-background";
import "./workspace-background.css";

export const WorkspaceBackground = memo(function WorkspaceBackground() {
  const background = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState(0);
  const rows = useMemo(() => asciiBackgroundRows(frame), [frame]);
  const textureId = useId();

  useEffect(() => {
    const element = background.current;
    const workspace = element?.parentElement;
    if (!element || !workspace) return;
    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
    const finePointer = matchMedia("(hover: hover) and (pointer: fine)");
    let timer: ReturnType<typeof setInterval> | undefined;
    let pointerFrame: number | undefined;

    function resetPointer() {
      if (pointerFrame !== undefined) cancelAnimationFrame(pointerFrame);
      pointerFrame = undefined;
      element!.style.setProperty("--ascii-active", "0");
      element!.style.setProperty("--ascii-shift-x", "0px");
      element!.style.setProperty("--ascii-shift-y", "0px");
    }
    function updateAnimation() {
      clearInterval(timer);
      timer = undefined;
      resetPointer();
      if (!reducedMotion.matches && !document.hidden) {
        timer = setInterval(() => setFrame(current => current + 1), 100);
      }
    }
    function movePointer(event: PointerEvent) {
      if (reducedMotion.matches || !finePointer.matches || event.pointerType !== "mouse") return;
      if (pointerFrame !== undefined) cancelAnimationFrame(pointerFrame);
      pointerFrame = requestAnimationFrame(() => {
        pointerFrame = undefined;
        const bounds = workspace!.getBoundingClientRect();
        const x = event.clientX - bounds.left;
        const y = event.clientY - bounds.top;
        element!.style.setProperty("--ascii-pointer-x", `${x}px`);
        element!.style.setProperty("--ascii-pointer-y", `${y}px`);
        element!.style.setProperty("--ascii-shift-x", `${(x / bounds.width - 0.5) * 8}px`);
        element!.style.setProperty("--ascii-shift-y", `${(y / bounds.height - 0.5) * 8}px`);
        element!.style.setProperty("--ascii-active", "1");
      });
    }

    updateAnimation();
    reducedMotion.addEventListener("change", updateAnimation);
    finePointer.addEventListener("change", resetPointer);
    document.addEventListener("visibilitychange", updateAnimation);
    workspace.addEventListener("pointermove", movePointer, { passive: true });
    workspace.addEventListener("pointerleave", resetPointer);
    return () => {
      clearInterval(timer);
      resetPointer();
      reducedMotion.removeEventListener("change", updateAnimation);
      finePointer.removeEventListener("change", resetPointer);
      document.removeEventListener("visibilitychange", updateAnimation);
      workspace.removeEventListener("pointermove", movePointer);
      workspace.removeEventListener("pointerleave", resetPointer);
    };
  }, []);

  return <div ref={background} className="workspace-ascii" aria-hidden="true">
    <div className="workspace-ascii-plane">
      <svg className="workspace-ascii-texture" viewBox="0 0 1440 1000" preserveAspectRatio="xMidYMid slice" focusable="false">
        <g id={textureId}>
          {rows.map((text, row) => <text key={row} x="0" y={row * 8 + 7} xmlSpace="preserve" textLength="1440" lengthAdjust="spacingAndGlyphs">{text}</text>)}
        </g>
      </svg>
      <div className="workspace-ascii-focus">
        <svg className="workspace-ascii-texture workspace-ascii-highlight" viewBox="0 0 1440 1000" preserveAspectRatio="xMidYMid slice" focusable="false">
          <use href={`#${textureId}`} />
        </svg>
      </div>
    </div>
  </div>;
});
