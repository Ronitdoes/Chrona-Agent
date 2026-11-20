# Rich research answers

Chrona streams Markdown and numbered sources as the research loop admits evidence.
The optional figure pass runs once after the answer, with the same configured
model and a maximum of 12 seconds inside the turn deadline. It receives parsed
Markdown anchors, bounded excerpts and image descriptions as untrusted data.
Markdown and citations remain available if the pass fails or returns no figures.

## Figures and source evidence

- Flow diagrams use connected, labeled nodes and directed edges. Stable
  conceptual explanations can use uncited flows. For researched flows, each
  edge references a source excerpt that names its endpoints.
- Timelines reference evidence for each date and event. Bar charts require a
  common period and one measurement in a common unit per quote. Line charts use
  distinct chronological labels and position points by elapsed time.
- Publisher images require publisher alt text or a provider description. The
  planner selects from bounded candidates tied to admitted pages. It receives
  candidate IDs and descriptions and cannot supply asset URLs. The browser
  validates stored URLs, loads images lazily with no referrer, and keeps the
  publisher link available on image failure.
  [Tavily Search](https://docs.tavily.com/documentation/api-reference/endpoint/search)
  · [Exa Search](https://exa.ai/docs/reference/search)

Validation checks structure, source references, quotes, units and values.
The model judges whether the source supports the relationship and whether
an image description fits the passage. Figures render from typed React
components using native SVG and readable text. Raw markup in Markdown is skipped.

## Anchors, streaming and history

The planner chooses an anchor from the parsed Markdown. Paragraphs insert the
figure immediately after the paragraph. Heading anchors insert at the end of
that section, before the next equal or higher heading. Source offsets
distinguish repeated headings. Fenced code is excluded. The Markdown renderer
inserts figures in the same tree so reference links and surrounding structure
continue to work.

The `answer_ui` event sends a complete snapshot of at most 64 KB. Version 2
contains up to six figure blocks and four images. Reader support includes
version 1 lead galleries and old turns with only Markdown. Mixed answers use
`externalStart` to scope figures and citations to the external answer.

Postgres stores the latest snapshot in the existing `turns.answer_ui` column.
History validates presentation separately from the transcript. Trace fields
include `ttftMs`, `firstVisualMs`, `totalMs` and `snapshotBytes`. The deterministic
API tests round-trip visual answers through the chat handler and saved history.
