"use client";

import { useId, useState } from "react";
import { BadgeCheck, ExternalLink, Globe2 } from "lucide-react";
import type { Source } from "../lib/agent/events";
import { displayDate, sourceDetails } from "../lib/research-ui";

export function SourceChip({ source, favicon, number }: { source: Source; number?: number; favicon?: string | false }) {
  const id = useId();
  const [failed, setFailed] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const details = sourceDetails(source);
  if (!details) return null;
  const published = displayDate(source.publishedDate);
  const image = favicon === false ? null : favicon ?? details.favicon;
  return (
    <span className="source-wrapper" onMouseEnter={() => setDismissed(false)} onFocus={() => setDismissed(false)}
      onKeyDown={(event) => { if (event.key === "Escape") setDismissed(true); }}>
      <a className="source-chip" href={details.url} target="_blank" rel="noopener noreferrer" aria-describedby={dismissed ? undefined : id}>
        {number ? <span>[{number}]</span> : null}
        {image && !failed ? (
          // A small, unoptimized same-source favicon needs native error handling and no remote-image allowlist.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={image} width={14} height={14} alt="" aria-hidden="true" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
        ) : <Globe2 size={14} aria-hidden="true" />}
        <span className="min-w-0 truncate">{details.domain}</span>
        {source.isOfficial ? <span className="inline-flex shrink-0 items-center gap-1 text-[10px]"><BadgeCheck size={12} aria-hidden="true" />Official</span> : null}
      </a>
      {!dismissed ? <span role="tooltip" id={id} className="source-tooltip">
        <span className="block rounded-xl border border-border bg-surface p-3.5 shadow-sm">
          <span className="mb-1 flex items-start gap-2 text-xs font-medium leading-relaxed text-foreground"><span className="min-w-0 wrap-anywhere">{source.title.trim() || details.domain}</span><ExternalLink size={12} className="mt-0.5 ml-auto shrink-0" aria-hidden="true" /></span>
          <span className="block text-[11px] text-muted">{published ? <>Published <time dateTime={source.publishedDate ?? undefined}>{published}</time></> : "Publication date unavailable"}</span>
        </span>
      </span> : null}
    </span>
  );
}

export function SourceChips({ sources, localFavicons = false, numbered = false }: { sources: Source[]; localFavicons?: boolean; numbered?: boolean }) {
  const unique = [...new Map(sources.filter((source) => sourceDetails(source)).map((source) => [source.url, source])).values()];
  if (!unique.length) return null;
  return <div aria-label="Sources" className="relative mt-5 flex flex-wrap gap-2 font-sans">
    {unique.map((source, index) => <SourceChip key={source.url} source={source} number={numbered ? index + 1 : undefined} favicon={localFavicons ? index === 0 ? "/demo-source.svg" : false : undefined} />)}
  </div>;
}
