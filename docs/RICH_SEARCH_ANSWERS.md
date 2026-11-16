# Rich search answers in Web Agent Core

**Status:** Gallery and citation infrastructure implemented. Diagrams and section anchoring remain proposed.

## Implemented first release

The authoritative v1 contract lives in `lib/answer-blocks.ts`. `answer_ui` snapshots contain ordered sources, up to four provider images, and one lead gallery. The first admitted source receives citation 1. Matching Markdown links preserve their descriptive text and gain a citation number. Snapshots also publish when research has sources and zero eligible images.

`web_search.include_images` is optional. Searches request images by default, and the model can explicitly disable them for text-only research. Both model transports use the shared declaration. Tavily result-level images and Exa rich image links remain separate from model evidence and survive search cache hits. Candidates become eligible only when their publishing page survives the loop's final evidence budget. Gallery cards append in admission order, at most one per source, and remain linked when a thumbnail fails.

Images returned by either Tavily or Exa can display directly after HTTPS URL validation and duplicate filtering. Each card links to its publishing page. Publisher alt text is used when available, with a source-title fallback. No manually maintained asset catalog is required. Deterministic fixtures cover both providers through search, cache, agent streaming, gallery markup and saved history.

Migration 7 adds `turns.answer_ui`. The chat handler saves the latest snapshot with assistant text. History validates presentation independently and retains the transcript when presentation cannot be read. Database transfer accepts versions 1 through 7, including older column lists. Mixed history answers buffer presentation and record the external prose offset so private-history links retain their original rendering.

The gallery uses native images with reserved space, lazy loading, no-referrer requests, linked credits, keyboard controls, horizontal scroll snapping and the shared Lenis hook. Markdown image suppression remains active. Snapshots are capped at 64 KB, below the SSE frame limit. Chat tracing includes `firstVisualMs` and `snapshotBytes`, with `ttftMs` still measuring first text.

## Original design and proposed follow-up

The sections below retain the original design rationale. Diagram schemas, section placements and optional renderer integrations are future work. The implementation above defines the shipped gallery contract.

For a question about movie post-credit scenes, the reader should be able to swipe through relevant images, open the publishing page for each one, and inspect a timeline beside the explanation. Reopening the conversation should restore the same images, placement, and citation numbers. A failed visual should still leave a complete, readable answer.

## Current request path

| Stage | Existing behavior | Implementation point |
| --- | --- | --- |
| Chat request | A Node.js route checks conversation ownership and credentials. The handler distinguishes history-only, mixed history/research, and general requests. | [Chat route](../app/api/chat/route.ts), [chat handler](../lib/chat.ts) |
| Agent loop | Anthropic and Gemini share a handwritten loop. The model has one tool, `web_search`. Effort profiles bound queries, sources, and time for synthesis. | [Loop](../lib/agent/loop.ts), [tool schema](../lib/agent/schema.ts), [Gemini transport](../lib/agent/gemini.ts), [effort profiles](../lib/research-effort.ts) |
| Search | Tavily and Exa adapters select text fields. Search deduplicates queries, limits concurrency to three by default, applies timeouts and fallback, and caches normalized results. The loop applies another budget before admitting evidence. | [Search execution](../lib/tools/webSearch.ts), [result normalization and budgeting](../lib/tools/results.ts) |
| Streaming | The server emits `status`, `delta`, `sources`, `error`, and `done`. The browser validates known events, stops at `done`, and batches text updates by animation frame. | [Server events](../lib/agent/events.ts), [browser parser](../lib/chat-stream.ts), [React event handling](../components/chat.tsx) |
| Display and history | Each assistant message has one Markdown body and a source-chip footer. Markdown images become alt text and raw HTML is skipped. Saved turns reconstruct the text without the live source chips. | [Message list](../components/message-list.tsx), [Markdown renderer](../components/markdown-message.tsx), [history projection](../lib/history.ts), [workspace reconstruction](../lib/workspace.ts) |

## 1. Retrieve images with their publishing pages

Add optional `include_images` to `webSearchInput`, enabled by default unless explicitly disabled. Both transports already derive their tool declaration from the shared schema. In `runAgent`, apply the turn's visual budget before passing the effective option to search. Include that effective flag in the cache key. Keep provider selection, account credentials, timeouts, and cancellation on the existing request path. [Tool schema](../lib/agent/schema.ts) · [Search executor](../lib/tools/webSearch.ts)

| Adapter | Proposed change |
| --- | --- |
| Tavily | Send `include_images: true` for a visual query. Parse each result's `images` and associate each candidate with that result's page URL. Top-level query images lack that direct page association. When image descriptions are enabled, treat them as generated text. [Adapter](../lib/tools/providers/tavily.ts) · [Tavily image response fields](https://docs.tavily.com/sdk/javascript/reference) |
| Exa | Add `contents.extras.richImageLinks: 2` alongside the existing highlights option. Parse `result.extras.richImageLinks` and use publisher alt text when available. The result-level `image` can also supply a page thumbnail. [Adapter](../lib/tools/providers/exa.ts) · [Exa Search API](https://exa.ai/docs/reference/search.md) |

Extend `ProviderResult` with optional image candidates. Keep those candidates in a separate server-side map keyed by canonical **page URL**. Pass text evidence through `normalizeResults`, `limitResearchSources`, and `fitBudget` as today. Join images only to pages that survive the loop's final budget. Persist candidate metadata in the search cache alongside its corresponding results so a cache hit can also produce a gallery. Discard malformed or duplicate candidates independently of the text result. [Provider types](../lib/tools/providers/types.ts) · [Final evidence selection](../lib/agent/loop.ts)

Accept valid HTTPS image candidates from both supported search providers. Give each card a visible publisher link and credit when supplied. Use an ordinary linked publisher card when a thumbnail is unavailable, ineligible, or fails to load. Keep original asset URLs and binary data outside the model prompt. A poster can illustrate the movie; a caption identifying a particular scene needs support from the publishing page.

## 2. Share a typed contract across the server, browser, and database

Create `lib/answer-blocks.ts` with strict Zod schemas and infer the TypeScript types from them. Keep `turns.content` as the complete Markdown transcript for copy, recall, and text indexing. The following sketch defines the companion presentation data. `Source` is the existing source shape from [agent events](../lib/agent/events.ts).

```ts
type Placement =
  | { kind: "lead" }
  | { kind: "afterSection"; heading: string; occurrence: number };

type AnswerBlock =
  | {
      id: string;
      kind: "gallery";
      placement: Placement;
      imageIds: string[];
    }
  | {
      id: string;
      kind: "diagram";
      placement: Placement;
      layout: "timeline" | "flow";
      title: string;
      nodes: { id: string; label: string; sourceIds: string[] }[];
      edges: { from: string; to: string; label: string; sourceIds: string[] }[];
      summary: string;
    };

type RichAnswerV1 = {
  version: 1;
  sources: (Source & { id: string })[];
  images: {
    id: string;
    sourceId: string;
    thumbnailUrl: string;
    alt: string;
    credit?: string;
  }[];
  blocks: AnswerBlock[];
};
```

Assign IDs on the server and keep them stable for the turn. Validate field lengths, collection sizes, unique IDs, known source and image references, and edge endpoints. A diagram planner can select known source IDs and propose plain-text labels. URL selection, renderer selection, and component props belong to the application.

Keep ordinary Markdown links in the transcript. In `MarkdownMessage`, compare each link's canonical destination with the turn's retrieved sources. Render a matching link as a numbered citation and reuse the source chip for publisher details. Assign numbers on first source admission and persist that order. A source match establishes provenance. Evaluate separately whether a page supports the attached claim. [Markdown renderer](../components/markdown-message.tsx) · [Source chips](../components/source-chips.tsx)

## 3. Stream complete visual blocks alongside incremental prose

1. Add an `answer_ui` event carrying a bounded `RichAnswerV1` snapshot. Register it in `AgentEvents`, the browser's Zod union, and its `knownEvents` set. Deploy the reader before enabling the writer. [Server contract](../lib/agent/events.ts) · [Client parser](../lib/chat-stream.ts)
2. Add an optional rich snapshot to `ChatMessage`. Replace it on each `answer_ui` event for the active assistant message. Duplicate snapshots should render identically. Preserve the existing late-event guard and the flush of pending text before non-text events. [State reducer](../lib/chat-state.ts) · [Chat component](../components/chat.tsx)
3. Emit `sources` followed by `answer_ui` when eligible images are available. Continue streaming prose through `delta`. Send a new snapshot only when its content changes. Enforce an encoded size limit comfortably below the client's 131,072-character frame limit. [Evidence emission](../lib/agent/loop.ts) · [Frame validation](../lib/chat-stream.ts)
4. For a requested diagram, give a tools-disabled planner the completed external answer, bounded evidence excerpts, and source IDs. Run it only when sufficient wall-clock budget remains. Buffer the JSON privately, validate the complete graph, and emit the snapshot **before** `done`. On timeout, cancellation, or invalid output, preserve the prose and any visuals already published. [Loop completion](../lib/agent/loop.ts) · [Time budgets](../lib/research-effort.ts)
5. Handle the mixed-history branch explicitly. It currently suppresses the inner agent's `delta` and `done` and then emits private-history text and external prose together. Buffer its `answer_ui` event and resolve placement within the external section of the composed answer. Keep history-only answers on the existing path without image retrieval. [Mixed-answer composition](../lib/chat.ts)

## 4. Render galleries and diagrams within the answer

Introduce `AnswerBody` at the assistant Markdown insertion point. A `lead` gallery appears above the prose. Resolve `afterSection` against headings in the parsed Markdown tree, using heading text and occurrence to disambiguate repeats. A section ends at the next heading of equal or higher rank, or at completion. Wait for that boundary while streaming. If an anchor is missing at completion, append the visual below the prose. The existing remark transform shows where to integrate this without disturbing code fences, lists, and tables. [Message list](../components/message-list.tsx) · [Research annotations](../lib/research-annotations.ts)

| Renderer | Implementation |
| --- | --- |
| Image gallery and cards | Add `components/image-gallery.tsx`. Use one card for a single image and a horizontally scrollable list with scroll snapping for several. Include keyboard-operable controls, stable aspect ratios, alt text, publisher links, lazy loading, and `referrerPolicy="no-referrer"`. Preserve native touch, reduced motion, chat auto-follow, and the reader's position when they have scrolled up. Keep Markdown's existing remote-image suppression. [Chat scrolling](../components/chat.tsx) · [Markdown image handling](../components/markdown-message.tsx) |
| Programmatic SVG | Add `components/answer-diagram.tsx` as the first renderer. Lay out timelines in order and small flows in rows. Build the shapes from React-owned SVG elements and plain-text labels. Provide a visible summary and source links for the relationships shown. |
| Mermaid | If additional layouts justify the dependency, lazy-load an adapter that serializes the validated graph using generated node IDs, escaped labels, strict security mode, and disabled HTML labels. Leave ordinary fenced examples as readable code. [Mermaid security configuration](https://mermaid.js.org/config/schema-docs/config-properties-securitylevel.html) |
| React Flow | For larger graphs, add an optional expanded, read-only view with pan and zoom. Map validated nodes and edges onto fixed components and computed coordinates. Load it only when opened. Keep the inline SVG and summary available on small screens. [React Flow component API](https://reactflow.dev/api-reference/react-flow) |

## 5. Persist and restore the answer

Add migration 7 for a nullable `turns.answer_ui jsonb` column. Extend the Drizzle definition and `SaveTurnInput`. Collect the latest validated and published snapshot in the chat handler and save it with assistant text in the existing owned-conversation transaction. For interrupted turns, resolve placement against the saved partial text. Keep visual metadata out of recall prompts and evidence curation. [Migrations](../lib/store/migrate.ts) · [Turn schema](../lib/store/schema.ts) · [Save transaction](../lib/store/queries.ts) · [Assistant persistence](../lib/chat.ts)

Carry the optional value through `HistoryTurn`, `groupHistory`, `historyPageSchema`, and `sessionMessages`. Validate the version on read and fall back to the Markdown transcript for old rows or unreadable presentation data. Update the snapshot importer, which currently caps migration versions at 6 and compares columns by version. Pre-v7 imports must accept the older `turns` column list. [History projection](../lib/history.ts) · [Client hydration](../lib/workspace.ts) · [Snapshot transfer](../lib/store/transfer.ts)

## Delivery and acceptance

| Increment | Acceptance check |
| --- | --- |
| Gallery, citations, and persistence | Replay a movie-search fixture with both providers. A gallery appears while prose streams, each card opens its publishing page, and reopening the chat restores image order and citation numbers. Test a cache hit, one broken image, and a page pruned by the final evidence budget. |
| Inline SVG | Replay an answer with a sourced timeline beside the intended section. Cover repeated headings, a heading inside a code fence, missing anchors, unsupported edges, and a planner timeout. With invalid diagram output the answer still completes. |
| Stream and history compatibility | Split an SSE frame across reads, repeat a snapshot, cancel a turn, then start another. Verify that a late visual cannot land in the next message. Cover mixed private history, history-only turns, older saved turns, and pre-v7 snapshots. |
| Performance | Track first text, first visual, total latency, and snapshot bytes separately. Preserve the meaning of `ttftMs` as time to first text. Compare text-only requests with the current baseline and verify that optional diagram libraries stay out of the initial chat bundle. |

Extend the existing [provider tests](../lib/tools/providers/providers.test.ts), [search tests](../lib/tools/webSearch.test.ts), [loop tests](../lib/agent/loop.test.ts), [stream tests](../lib/chat-stream.test.ts), [reducer tests](../lib/chat-state.test.ts), [API tests](../test/api.test.ts), [workspace tests](../lib/workspace.test.ts), and [snapshot tests](../lib/store/transfer.test.ts). Use deterministic provider fixtures for the acceptance checks and the repository's injected clock for timing.
