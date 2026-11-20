import { useId } from "react";
import { visualCitations, type RichAnswerV2, type VisualBlock } from "../lib/answer-blocks";
import { ImageCard } from "./image-gallery";
import { chartPeriod } from "../lib/chart-period";

function Flow({ block }: { block: Extract<VisualBlock, { kind: "flow" }> }) {
  const arrow = useId();
  const spacing = 90;
  const center = (index: number) => index * spacing + 38;
  return <>
    <svg className="mx-auto block w-full max-w-96 text-accent" viewBox={`0 0 350 ${block.nodes.length * spacing - 14}`} aria-hidden="true">
      <defs><marker id={arrow} markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
        <path d="M0 0L7 4L0 8Z" fill="currentColor" />
      </marker></defs>
      {block.edges.map(({ from, to }, index) => {
        const x = 252 + index * 9;
        return <path key={index} d={`M232 ${center(from)} H${x} V${center(to)} H236`} fill="none"
          stroke="currentColor" strokeWidth="1.5" markerEnd={`url(#${arrow})`} />;
      })}
      {block.nodes.map((node, index) => (
        <g key={index}>
          <rect x="8" y={center(index) - 30} width="224" height="60" rx="8" className="fill-surface stroke-border" />
          <foreignObject x="18" y={center(index) - 26} width="204" height="52">
            <div className="flex h-full items-center justify-center text-center text-sm leading-tight text-foreground [overflow-wrap:anywhere]">{node}</div>
          </foreignObject>
        </g>
      ))}
    </svg>
    <ul className="mt-3 space-y-1 text-sm text-muted">
      {block.edges.map(({ from, to, label }, index) => <li key={index}>{block.nodes[from]} → {block.nodes[to]}{label ? ` · ${label}` : ""}</li>)}
    </ul>
  </>;
}

function Timeline({ block }: { block: Extract<VisualBlock, { kind: "timeline" }> }) {
  return <ol className="space-y-0">
    {block.events.map((event, index) => <li key={index} className="relative grid grid-cols-[1rem_1fr] gap-3 pb-4 last:pb-0">
      <svg className="h-full min-h-8 w-4 text-accent" viewBox="0 0 16 32" preserveAspectRatio="none" aria-hidden="true">
        {index < block.events.length - 1 ? <path d="M8 7V32" stroke="currentColor" vectorEffect="non-scaling-stroke" /> : null}
        <circle cx="8" cy="7" r="3.5" fill="currentColor" />
      </svg>
      <div><p className="font-medium">{event.date}</p><p className="text-muted">{event.label}</p></div>
    </li>)}
  </ol>;
}

function Chart({ block }: { block: Extract<VisualBlock, { kind: "chart" }> }) {
  const { points, style, unit, period } = block;
  const values = points.map(point => point.value);
  const min = Math.min(...values, ...(style === "bar" ? [0] : []));
  const max = Math.max(...values, ...(style === "bar" ? [0] : []));
  const y = (value: number) => max === min ? 152 : 152 - (value - min) / (max - min) * 126;
  const width = 360;
  const step = 320 / points.length;
  const periods = style === "line" ? points.map(point => chartPeriod(point.label)) : [];
  const first = periods[0];
  const last = periods.at(-1);
  const x = (index: number) => {
    const period = periods[index];
    if (period !== undefined && first !== undefined && last !== undefined && last > first) {
      return 32 + 296 * (period - first) / (last - first);
    }
    return 20 + step * (index + 0.5);
  };
  const baseline = y(style === "bar" ? 0 : min);
  return <>
    <p className="mb-2 text-xs text-muted">{unit}{period ? ` · ${period}` : ""}</p>
    <svg viewBox={`0 0 ${width} 180`} className="block w-full text-accent" aria-hidden="true">
      <path d={`M16 ${baseline}H344`} className="stroke-border" />
      {style === "line" ? <polyline fill="none" stroke="currentColor" strokeWidth="2.5"
        points={points.map((point, index) => `${x(index)},${y(point.value)}`).join(" ")} /> : null}
      {points.map((point, index) => <g key={point.label}>
        <title>{point.label} · {point.value} {unit}</title>
        {style === "bar" ? <rect x={x(index) - step * 0.3} y={Math.min(y(point.value), baseline)} width={step * 0.6}
          height={Math.max(1, Math.abs(baseline - y(point.value)))} rx="2" fill="currentColor" />
          : <circle cx={x(index)} cy={y(point.value)} r="4" fill="currentColor" />}
        <text x={x(index)} y="170" textAnchor="middle" className="fill-muted text-[10px]">{index + 1}</text>
      </g>)}
    </svg>
    <ol className="divide-y divide-border text-sm">
      {points.map((point, index) => <li key={point.label} className="flex items-baseline justify-between gap-3 py-1.5">
        <span><span className="mr-2 text-xs text-muted">{index + 1}</span>{point.label}</span>
        <span className="shrink-0 font-medium tabular-nums">{point.value.toLocaleString("en-US", { maximumSignificantDigits: 17 })} {unit}</span>
      </li>)}
    </ol>
  </>;
}

export function AnswerFigure({ answer, block }: { answer: RichAnswerV2; block: VisualBlock }) {
  const heading = useId();
  if (block.kind === "image") {
    const image = answer.images.find(item => item.id === block.imageId);
    const index = answer.sources.findIndex(item => item.id === image?.sourceId);
    if (!image || index < 0) return null;
    return <figure className="my-5"><ImageCard image={image} source={answer.sources[index]} number={index + 1} inline /></figure>;
  }
  const ids = new Set(visualCitations(block).map(item => item.sourceId));
  return <figure aria-labelledby={heading} className="my-5 rounded-xl border border-border bg-surface-2 p-4 font-sans text-sm sm:p-5">
    <figcaption id={heading} className="mb-4 font-medium text-foreground">{block.title}</figcaption>
    {block.kind === "flow" ? <Flow block={block} /> : block.kind === "timeline" ? <Timeline block={block} /> : <Chart block={block} />}
    {ids.size ? <ul aria-label="Figure sources" className="mt-4 flex flex-wrap gap-x-3 gap-y-1 border-t border-border pt-3 text-xs text-muted">
      {answer.sources.map((source, index) => ids.has(source.id) ? <li key={source.id}><a href={source.url} target="_blank" rel="noopener noreferrer"
        className="underline underline-offset-2">[{index + 1}] {source.domain}</a></li> : null)}
    </ul> : null}
  </figure>;
}
