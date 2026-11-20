"use client";

import { useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ImageOff } from "lucide-react";
import type { RichAnswer, RichAnswerV1 } from "../lib/answer-blocks";
import { useSmoothScroll } from "./smooth-scrolling";

export function ImageCard({ image, source, number, inline = false }: { image: RichAnswerV1["images"][number]; source: RichAnswerV1["sources"][number]; number: number; inline?: boolean }) {
  const [failed, setFailed] = useState(false);
  return <a href={source.url} target="_blank" rel="noopener noreferrer" className={`block ${inline ? "w-full max-w-xl" : "w-64 shrink-0 snap-start"} overflow-hidden rounded-xl border border-border bg-surface-2 font-sans text-xs focus-visible:outline-2 focus-visible:outline-offset-2`}>
    <div className="flex aspect-video items-center justify-center bg-surface">
      {failed ? <span className="flex items-center gap-2 text-muted"><ImageOff size={16} />Image unavailable</span> : (
        // Provider images load directly so image errors preserve the publishing-page link.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={image.thumbnailUrl} alt={image.alt} width={256} height={144} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} className={`h-full w-full ${inline ? "object-contain" : "object-cover"}`} />
      )}
    </div>
    <div className="space-y-1 p-3"><p className="truncate">[{number}] {source.domain}</p>{image.credit ? <p className="truncate text-muted">{image.credit}</p> : null}</div>
  </a>;
}

export function ImageGallery({ answer }: { answer: RichAnswer }) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  useSmoothScroll(viewport, content, answer.version === 1 && answer.images.length > 0, "horizontal");
  if (answer.version !== 1 || !answer.images.length) return null;
  const move = (direction: number) => {
    const element = viewport.current;
    if (element) element.scrollBy({ left: direction * 272, behavior: "instant" });
  };
  return <section aria-label="Images from sources" className="my-4">
    {answer.images.length > 1 ? <div className="mb-2 flex justify-end gap-2">
      <button type="button" aria-label="Previous image" onClick={() => move(-1)} className="rounded border border-border p-1"><ChevronLeft size={18} /></button>
      <button type="button" aria-label="Next image" onClick={() => move(1)} className="rounded border border-border p-1"><ChevronRight size={18} /></button>
    </div> : null}
    <div ref={viewport} data-lenis-scroll tabIndex={0} role="region" aria-label="Source image gallery" className="overflow-x-auto overscroll-x-contain snap-x snap-mandatory">
      <div ref={content} className="flex w-max gap-4 pb-2">
        {answer.blocks.flatMap(block => block.imageIds).map(id => {
          const image = answer.images.find(image => image.id === id)!;
          const index = answer.sources.findIndex(source => source.id === image.sourceId);
          return <ImageCard key={id} image={image} source={answer.sources[index]} number={index + 1} />;
        })}
      </div>
    </div>
  </section>;
}
