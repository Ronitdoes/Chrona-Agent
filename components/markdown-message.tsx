"use client";

import { Children, isValidElement, useEffect, useRef, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import { remarkResearchAnnotations } from "../lib/research-annotations";
import { AsOfChip, VerdictBadge } from "./research-badges";

function CodeBlock({ children, ...props }: ComponentPropsWithoutRef<"pre">) {
  const pre = useRef<HTMLPreElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const code = Children.toArray(children).find((child) => isValidElement<{ className?: string; children?: ReactNode }>(child));
  const language = isValidElement<{ className?: string }>(code) ? /language-([^\s]+)/.exec(code.props.className ?? "")?.[1] : undefined;
  async function copy() {
    try { await navigator.clipboard.writeText(pre.current?.textContent ?? ""); setState("copied"); }
    catch { setState("failed"); }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2000);
  }
  return (
    <div className="code-block my-5 overflow-hidden rounded-xl border border-border bg-surface-2">
      <div className="flex items-center justify-between border-b border-border px-4 py-2 font-sans text-[11px] text-muted">
        <span>{language ?? "Code"}</span>
        <button type="button" onClick={copy} aria-label={state === "copied" ? "Code copied" : "Copy code"}
          className="flex items-center gap-1.5 rounded px-1.5 py-1 hover:text-foreground">
          {state === "copied" ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
          <span role="status">{state === "copied" ? "Copied" : state === "failed" ? "Couldn’t copy" : "Copy"}</span>
        </button>
      </div>
      <pre ref={pre} {...props}>{children}</pre>
    </div>
  );
}

const components: Components = {
  span: ({ node, children, ...props }) => {
    const verdict = node?.properties["data-verdict"] ?? node?.properties.dataVerdict;
    if (verdict === "changed" || verdict === "unchanged" || verdict === "unknown") return <VerdictBadge verdict={verdict} />;
    const date = node?.properties["data-as-of"] ?? node?.properties.dataAsOf;
    if (typeof date === "string") return <AsOfChip date={date} />;
    return <span {...props}>{children}</span>;
  },
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
  // Remote image URLs in model text should not silently make browser requests.
  img: ({ alt }) => <span className="text-muted">{alt ? `[Image: ${alt}]` : "[Image]"}</span>,
};

export function MarkdownMessage({ content }: { content: string }) {
  return <Markdown remarkPlugins={[remarkGfm, remarkResearchAnnotations]} components={components} skipHtml>{content}</Markdown>;
}
