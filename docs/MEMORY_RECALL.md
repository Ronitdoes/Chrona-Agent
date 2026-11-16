# Evidence-backed conversation recall

This is the current recall contract. The [historical audit](MEMORY_AUDIT.md)
records the earlier failure analysis; [architecture](ARCHITECTURE.md) describes
the surrounding application and [design decisions](DESIGN.md) explain the
tradeoffs.

## Request interpretation

Every request first uses the selected provider for structured intent/reference
planning. The plan classifies `general`, `history` or `mixed` intent, selects
`exists`, `when`, `list`, `summarize` or `revalidate`, and supplies bounded topical variants,
session scope, an exact user date phrase and any verified-antecedent reference.
Planning is inference, not an additional model-facing tool.

Collection intent is explicit: `new` for a bounded day/session, `previous` for
the exact preceding collection, `all` for an explicit all-history request and
`none` for topical recall or general/mixed research. An empty query is never
permission to enumerate all history. The former regex wording shortcut has been
removed so there is one interpretation path.

Inventories read fresh user-only pages across conversations, apply local-day UTC
bounds to each message (regardless of when its session started), exclude the
current request and render timestamps directly. They retain up to 1,000 recent
messages within the output budget and disclose omissions. Date/time and recall
questions remain inventory candidates. SQL applies ownership and session scope
before pagination. No answer model, web search or curator runs for a plain list.

Date phrases are copied from user text and resolved by injected-clock functions.
For collections, explicit dates in the current request are also resolved in code
and take precedence over a missing/stale planned date or previous collection.
Ambiguous/invalid dates and unsupported sub-day/arbitrary interval scopes require
clarification instead of an unrestricted query. A temporal adverb such as “now”
does not reset a previous collection to today. A missing new date requires a
session scope, an explicit all-history plan or a verified previous collection.
Revalidation guidance includes a topic-only query variant because attributes
such as pricing can occur only in the adjacent assistant answer. The fresh
subquestion of a mixed request retains source restrictions, output format,
fictional context and search-budget instructions. A planning failure produces
uncertainty rather than an ungrounded answer or public search.

Summary plans use tool-free structured inference. At most 100 of the newest
messages, 2,000 characters per message and 24,000 total selected-message characters
enter this call. Each message receives its own item and single source ID; a
catch-all item covering unrelated messages is rejected. Identical original text
with identical generated summaries can be grouped by the server. Dates, times
and counts render from records and the injected clock.

Up to four earlier same-session user messages per selected message explain
elliptical continuations, including across midnight. Context is bounded to 800
characters per message and 16,000 characters total. Context-only messages never
enter the selected-day counts or source-ID set. Assistant answers are excluded.
If the subject remains unclear, synthesis must preserve uncertainty. Both
selected originals and supplied context are re-read after inference. Invalid, unavailable or
changed-source summaries fall back to fresh original messages, never a false
history miss. Omitted messages/details are disclosed. Paraphrase accuracy still
depends on the model; source membership does not prove semantic entailment.

## Evidence retrieval and validation

History retrieval starts with original user messages. Ownership, role,
session/date constraints and the strict pre-request timestamp/ID cursor are
applied in SQL before ranking/limiting. Up to three AND-term full-text variants
are combined; at most three pages of ten candidates are examined. Neighboring
messages provide context for interpretation.

A structured model selects candidate IDs and exact contiguous quotes. The
service checks those IDs, quoted excerpts, ownership and chronology against
original records and re-reads selected sources after inference. Deleted or
out-of-scope evidence invalidates the answer before it is emitted. Long user
messages retain relevant exact excerpts independently of assistant-answer size.

Summaries, memory facts and assistant recollections are not original user
evidence. Valid ownership and quote membership also do not mathematically prove
semantic entailment: selection still depends on a model. Missing evidence means
no supported original was found in the searched scope, not that the user never
asked. Unchecked candidates, ambiguity and unavailable verification remain
explicit.

## Rendering and follow-ups

History-only answers render stored quotes and local timestamps without a
free-form answer model or web search; message summaries use the bounded
structured synthesis above. Display text escapes stored Markdown.
Ambiguous matches ask for clarification; missing dates or antecedents do not
produce fabricated timestamps.

Source IDs are saved atomically with the request/assistant linkage in
`recall_references`. Only the most recent assistant answer in the session can
supply an antecedent. A timestamp follow-up rehydrates those exact originals and
rechecks ownership, scope and deletion. Failed or ambiguous recall records an
empty source set to prevent stale antecedents.

Inventories/summaries keep their topical antecedent list empty and separately
persist collection provenance: exact displayed source IDs, absolute UTC ranges,
original cutoff, timezone, optional session scope and truncation. “Show those
messages” rehydrates only that set after ownership, chronology, scope and deletion
checks. It excludes the summary request and later messages and remains stable
across midnight. Missing/deleted provenance never expands into all history.
Legacy summaries without collection metadata require a fresh request for the day.
A new explicit day always reads fresh records instead of reusing the collection.
Date phrases resolve against each request's injected instant and timezone. Date
format examples use that calendar rather than a fixed example day. Startup
validation rejects invalid default timezones and calendar override timestamps;
`NOW_OVERRIDE` remains an explicit evaluation setting and should be empty for
the live clock.

History-only recall requests are excluded from later topical searches, avoiding
confirmation from the question about remembering a request. Mixed requests
remain candidates because they may also include a real new external request.

## Mixed requests and general research

Mixed requests compose two sections: verified private history from records and
fresh external research. Revalidation includes bounded original baseline text.
Summaries and previous assistant recollection claims are not replayed as proof
into that external answer. Generated mixed-answer text is buffered until the
research loop finishes. The answer model still sees only `web_search`.

History and mixed paths skip curation so generated recollections cannot become
new durable memory. General research retains its separate transcript/claim/
memory/thread context path and eligible curation. Derived general-context data
is labeled as a hint with source attribution, not proof of a past question. Its
default 6,000-byte budget can omit oversized fetched pairs; this is distinct from
the history service's user-first candidate contract.

## Persistence, budgets and tracing

The store uses the required Docker or hosted Postgres connection and a single
node-postgres driver. Automatic migrations maintain recall references and their
history-only flag; migration 5 adds nullable collection provenance without
rewriting transcripts. Snapshot import accepts versions 1–5. Development reloads reuse the pool, apply pending migrations
and refresh query methods together.

Planning, retrieval and synthesis share the selected effort's time budget.
Fractional monotonic durations are rounded to positive integer milliseconds for
Node timeout APIs. Recall traces record intent, operation, candidate/evidence
IDs, coverage and abstention reason without full private messages or credentials.

The relevant implementation boundaries are:

| Module | Responsibility |
|---|---|
| `lib/recall/history-list.ts` | Deterministic inventories |
| `lib/recall/history-summary.ts` | Bounded source-linked summaries and original-message fallback |
| `lib/recall/plan.ts`, `lib/recall/model.ts` | Structured interpretation and provider adapters |
| `lib/recall/history.ts` | Scoped retrieval, evidence checks and rendering |
| `lib/store/recall.ts` | Owned history queries and persisted source references |
| `lib/chat.ts` | Routing, budgets, answer composition and deferred persistence |

## Validation and remaining limits

Start the isolated test database with `npm run db:test:up`, then use `npm test`,
`npm run eval`, `npm run typecheck` and `npm run lint`. Coverage includes the
two-turn recall/timestamp incident, assistant-only matches, negated/quoted/
hypothetical decoys, long messages, scoped pagination, source deletion, forged
IDs/quotes, ambiguous matches, planner failures, mixed requests, fractional
timing, both provider transports and all effort modes.

`npm run recall:live-eval` is a separate paid opt-in using synthetic candidates;
it performs no conversation or curation writes and skips providers without keys.
`npm run eval:live` checks configured recall and answer models together on a
restricted fictional hosting fixture with synthetic search. Gemini passed the
recorded live checks; this does not establish broad accuracy or live Anthropic
coverage. The collection/context changes additionally pass the live Gemini
checks for collection references, midnight continuations, broad recap planning,
duplicate-message coverage, topical recall and timestamp follow-ups. Anthropic
live checks skip without a key. The summary wire format uses a scalar `turnId`
per item because array-length constraints alone did not prevent grouped IDs in
Gemini output; the executor still validates complete, unique coverage.

Prior validation recorded a passing production Turbopack build. The
current Windows workspace check fails while starting Turbopack's CSS worker,
including outside the sandbox; default production-build verification remains
incomplete here. Source tests, deterministic evaluations, TypeScript and lint
validate the recall executor independently of that build limitation.

Full-text variants can still miss paraphrases, model interpretation can still be
wrong, and bounded candidate coverage cannot establish a universal negative.
Generated external prose is not a universal deterministic verification surface.
The current evaluation sets are regression evidence, not a production accuracy
benchmark. Consider hybrid/vector retrieval only after labeled evaluations
demonstrate candidate-recall gaps; it cannot replace the evidence contract.
