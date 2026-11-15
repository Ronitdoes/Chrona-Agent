# DESIGN

## 1. The core insight

## 2. Architecture and request flow

Step 7 adds Node route handlers for `POST /api/chat` and `GET /api/history`, both
explicitly `force-dynamic`. The installed Next.js version disallows those segment
exports under Cache Components, so the scaffold's Cache Components and Partial
Prefetching opt-ins are disabled together. No UI code depended on them. The routes
use the installed guides for `after()` and request/response streaming rather than
older synchronous request APIs.

The chat route validates a bounded JSON body, resolves a random UUID `user_id`
cookie and conversation `session_id`, then starts the user write concurrently
with recall. The just-written turn is excluded from recall and recent-session
context, so a new question cannot masquerade as an old memory. Recent session
turns are bounded and added to the model's conversation for natural follow-ups.
The user write must succeed before any model call starts.

`after()` is registered while the request context is active and awaits the stream
outcome. It saves the exact assistant text already emitted, including partial
answers on errors or cancellation. The route emits only the loop's single `done`
event (or its own terminal pair if preparation fails), then closes the stream.
`X-Session-Id` identifies the conversation. `X-Turn-Id` and `done.turnId` are a
request UUID; the single pino completion record joins that ID to the numeric user
and assistant database IDs. It logs handler recall time, time to first text delta,
search count, total response time and persistence outcome, without logging user
text, API keys, connection strings or provider error bodies.

History uses user-scoped timestamp/ID keyset pagination with an optional session
filter. Responses contain sessions with turns grouped by the requested timezone's
local calendar day, an optional `nextCursor`, and `private, no-store` headers.
Each page is a window of history; clients merge older pages by session and turn ID.
Titles use the first user message present on the page. Cookie IDs and generated
search vectors are omitted from individual history turn payloads.

The cookies are HttpOnly, SameSite=Lax, path-scoped to the app, and Secure in
production or over HTTPS. They provide anonymous continuity, not account login.
An instance-local limiter permits one active request per user and ten per minute;
admission is released after background persistence to avoid racing the next turn.
Revisit signed account sessions and shared rate limiting before exposing direct
account data or scaling across multiple server instances.

Step 3 stores `turns`, `claims`, `memory` and `threads` in Postgres through a shared
Drizzle schema. A required, validated `DATABASE_URL` configures a `pg.Pool` through
`drizzle-orm/node-postgres`. Local development uses the Postgres 18 Docker Compose
service with a persistent named volume and a localhost-only port. Start it with
`npm run db:up` before `npm run dev`; hosted deployments supply their own Postgres
URL. There is no embedded fallback. Connection startup has a bounded timeout and
reports failures without exposing credentials.

Next.js's Node instrumentation hook awaits `getStore()` before handling requests.
A shared initialization promise reuses the connection during development reloads.
The driver applies append-only, hand-written SQL in `lib/store/migrate.ts`.
A transaction and advisory lock serialize first boot, and a migration ledger makes
repeat startup a no-op. Failed migrations roll back and close the client. SQL is
embedded so deployment does not depend on copying migration files at runtime;
`drizzle.config.ts` describes the schema for authoring, while startup SQL remains
the migration authority.

The generated English `tsvector` and GIN index support parameterized
`websearch_to_tsquery` searches, ranked by relevance with a recency boost computed
from an injected reference instant. `(user_id, ts)` supports half-open date ranges.
Claims lookup and recent-thread indexes match their user-scoped access patterns.
The six query helpers are methods on the store returned by `getStore()` or
`createStore()`. Every read requires a user ID; recall crosses sessions but never
users. Claim reads also check ownership of the linked turn. Turn writes use the
injected clock when no explicit timestamp is supplied.

This uses one Postgres data model and full-text search implementation across
local development, tests and hosted deployments. A separate disposable Docker
test service and one database per suite isolate test cleanup from application data.
Application-scoped isolation fits
the cookie-based user model; revisit database row-level security if untrusted
clients ever receive direct database access.

## 3. Why recall combines semantic planning with deterministic evidence

A structured call first identifies general, history-only and mixed requests and
resolves follow-up references from bounded session context. It exposes no tools.
History-only answers retrieve original user messages and render validated quotes
and stored timestamps directly, without web search or free-form answer generation.
Ownership, chronology, quote membership, date ranges and persistence remain plain
tested code. A model selects semantic matches, so a valid ID and quote do not by
themselves prove the interpretation is correct. Missing evidence produces scoped
uncertainty rather than a claim that a conversation never happened.

Validated source IDs persist with history answers for timestamp follow-ups and
are rechecked after deletion. Recorded history-only recall requests are excluded
from topical search to prevent self-confirmation. Summaries and assistant claims
are not original user evidence. Mixed requests keep history and fresh external
research separate; the answer loop still has only `web_search`. Interpretation,
retrieval and synthesis share the selected effort's time budget. This costs an
extra model call on ordinary turns in exchange for context-aware routing.
See [the implementation and evaluation](docs/MEMORY_RECALL.md) for bounds and tests.

For general research context, Step 6's `retrieve({ userId, text, now })` resolves dates and starts independent
turn-range, memory and thread queries concurrently. Claims load as soon as the
matching turn IDs are known. The default store comes from `getStore()`, while
tests inject a store. Recall remains user-scoped across sessions. No date match
triggers a bounded, parameterized full-text OR query after removing recall
boilerplate and date words. Empty keywords do not fetch arbitrary history.
Missing requested ranges remain explicit even when keyword fallback finds other
dates; a background match never establishes what happened on a missing day.

Recall keeps complete fetched user/assistant pairs together during truncation and
never includes claims whose original turn was omitted. Keyword ranking controls
selection before the retained transcript is ordered chronologically. The default
content budget uses 6,000 UTF-8 bytes as a conservative token upper bound;
oversized rows are omitted instead of rewriting their historical text. `truncated`
distinguishes budget omission from `notFound`. Rows are also checked for user
ownership at the assembly boundary.

Step 2 resolves calendar expressions in plain code before retrieval queries. `now(tz)` in
`lib/clock.ts` supplies the instant, timezone, ISO timestamp and readable local
time. `NOW_OVERRIDE` accepts an ISO timestamp with `Z` or an explicit UTC offset
so evals do not depend on the host timezone. Explicit date construction also lives
in this module; the resolver receives its reference instant as an argument.

`resolveDates(text, now, tz)` uses chrono-node to extract expressions with the
user's local reference date. Bare weekdays resolve to the most recent occurrence,
including today; “last Tuesday” is strictly before today. Month/day expressions
without a year roll back a year when necessary. “On the 3rd” means the most recent
valid 3rd, skipping months that lack the requested day. “Last week” means the
previous Monday through Sunday. Explicit years are preserved.

Ranges include local midnight at the start and exclude local midnight after the
last day (`startUtc <= ts < endUtc`). Each boundary is converted independently to
UTC, so daylight saving days can contain 23 or 25 hours. Multiple expressions
retain their order, duplicate ranges are removed, and text without a date returns
an empty list for the later keyword fallback. Labels contain the resolved calendar
date for the answer to repeat back to the user.

This chooses deterministic parsing over model calendar arithmetic, which would
add latency and make recall harder to reproduce. Weekday and week-boundary
conventions remain ambiguous in natural language; revisit them if user feedback
calls for locale-specific week starts or different weekday semantics. The prompt
and answer integration belongs to later steps.

## 4. The claims ledger and diff engine

Step 5 provides two pure comparison functions. `diffClaim(oldValue, evidenceText)`
extracts canonical values and compares them; its verdict describes the values
only. `revalidateClaim(claim, evidence, nowInstant)` additionally requires a valid
publication timestamp strictly after the claim and no later than the injected
current instant. Missing, stale, same-instant or future dates force `unknown`,
even when the parsed values match. Callers must use this dated function for a
confirmed answer and retain the source URL for attribution. These functions do
not search, update the ledger or call a model; later steps supply those pieces.

Currency symbols and ISO codes normalize to a common currency (`$` means USD;
`C$` and `A$` distinguish CAD and AUD). Decimal strings preserve precision beyond
JavaScript's safe integer range, including common comma/dot grouping conventions.
Seat/user/account units and billing abbreviations normalize, but currencies are
not converted. Monthly and annual billing remain different terms: `$20/month`
and `$240/year` are not interchangeable offers. Explicit billing commitments are
also retained; if only one value specifies a commitment, the comparison is
unknown. Missing or incompatible dimensions likewise stay unknown.

Quantities support seat counts, request/token/project counts, percentages and
storage. SI storage units use powers of 1000 and IEC units use powers of 1024;
BigInt arithmetic makes conversion exact. Version values normalize missing minor
and patch components, preserve prereleases and ignore build metadata. Boolean
values support common affirmative/negative forms and explicit negation.

Evidence must be a passage about the selected subject and attribute. Multiple
distinct comparable values produce `unknown`; repeated equivalent values count
once. The parser avoids treating money amounts as release versions. It implements
these value grammars rather than general language understanding, so the caller
must select relevant evidence instead of passing a mixed pricing page as one
claim. Revisit with attribute-specific parsers if unsupported value formats
regularly cause unknown results; do not resolve ambiguity by taking the first
number or by asking the model to perform arithmetic.

`hints(claims, clock)` groups subjects case-insensitively, combines their attribute
terms and emits one bounded query per subject in first-mention order. Pricing
and release/version claims receive focused query terms plus the user's current
local year. No subjects are silently dropped to fit a search batch; the later
agent loop handles batching and its own budgets. The original turns remain the
source of truth alongside extracted claims.

Step 8 runs a separate extraction pass inside the existing `after()` task,
after the assistant turn is saved and the SSE stream is closed. The Anthropic
provider uses Haiku and the SDK's `messages.parse()` and `zodOutputFormat()` with
[`output_config.format`](https://platform.claude.com/docs/en/build-with-claude/structured-outputs).
Google AI Studio uses native schema-constrained JSON with the selected Gemini
model and key. Output passes through the same strict Zod schema and provenance
checks before any database writes. Curation requires only the selected provider's
key, including retries of pending extraction jobs.
The curator has no tools; the answering agent still has exactly one, `web_search`.
Its strict schema rejects malformed, incomplete or refused responses. Claims
require verbatim excerpts from both the answer and a cited search result that
support the extracted value. URLs must belong to that answer's search evidence;
future source dates and invented excerpts are rejected. Durable user facts also
require a supporting user excerpt. Thread summaries remain model interpretations,
and cannot override the original transcript.

The assistant turn and its pending curation record are saved in one transaction.
The record retains bounded search excerpts for retries after failures or process
restarts. Each pass attempts at most two jobs, reserving a slot for the current
answer so persistent failures cannot block fresh extraction. Model calls have a
six-second timeout and a shared twelve-second deadline, with no automatic provider
retries. Network calls occur outside database transactions. The next message is
admitted after persistence, without waiting for extraction; response timing excludes
curation and the single turn trace reports its outcome separately.

Validated merges and completion marking share one transaction, serialized per
user with a Postgres advisory lock. Repeated or concurrent passes cannot insert
duplicate claims. Equivalent values reuse the original immutable baseline;
conflicting values require the deterministic diff and newer dated evidence before
inserting the replacement and setting `superseded_by`. Unverifiable conflicts
leave the ledger unchanged. Memory keys and topic titles merge case-insensitively;
timestamps and source turn IDs prevent delayed retries from reverting newer notes.
Curator failures roll back only extraction, preserving both saved turns and the
pending record. The curator follows `MODEL_PROVIDER` for consistent key requirements
and billing. Revisit a durable worker queue if the host cannot honor post-response
work or retry backlogs become significant.

## 5. The single upgraded tool

Step 4 exposes one model-facing definition, `web_search`. Its zod validator and
JSON input schema share the same source. A call accepts 1–6 queries plus optional
recency, since-date, topic, official-source preference and extraction depth. The
adapter fans out with `p-limit` (three active queries per instance), giving each
provider attempt an eight-second timeout via `p-timeout`. A timeout aborts the
underlying request before trying the optional Exa fallback. Caller cancellation
also cancels active requests and prevents queued searches and fallbacks.

Tavily uses its documented [`time_range`, `start_date`, `include_raw_content` and
domain-preference fields](https://docs.tavily.com/documentation/api-reference/endpoint/search).
Deep mode requests advanced search plus Markdown content in that same request.
Fast mode uses basic search without raw page content. Exa uses the documented
[`startPublishedDate` and `contents` options](https://exa.ai/docs/reference/search),
with the later of an explicit since-date and an injected-clock rolling window
(1, 7, 30 or 365 days). Extraction is internal to this adapter: the model receives
no page-fetching tool. Exa's domain filter restricts results, so its official-source
boost happens locally instead.

A conservative server-owned vendor/domain map supplies official-source hints;
subdomains match only at hostname boundaries. Unknown vendors remain unclassified,
and callers can inject another trusted mapping in code. Tavily's `prefer` mode
retains third-party coverage. Results drop unsafe URL schemes and credentials,
remove common tracking parameters and fragments, deduplicate within each query,
and favor dated sources (and official sources when requested). Missing or ambiguous
publication dates stay null; a successful search never invents a publication date.

An in-memory LRU cache stores successful normalized results per query and filter
set. News and day-filtered searches expire after one minute; week, month and
general/year searches expire after five minutes, fifteen minutes and one hour.
The injected clock controls expiry. Failed searches are not cached. Repeated
queries within a call share work; a failed query preserves the other queries'
results. All-failed calls and invalid input return `is_error: true`, and partial
failures remain explicit per query. Provider response bodies and transport errors
are never forwarded to the model, since they may contain credentials.

One `<search_result>` data wrapper contains JSON with angle brackets escaped, so
page text cannot close the wrapper. The default output budget is 8,000 UTF-8 bytes,
used as a conservative token upper bound including metadata and wrappers. The
adapter drops lower-ranked hits, then shortens fields while preserving each query
when space permits. `truncated` makes this loss visible. The later system prompt
must also state that page content is data, never instructions.

This chooses a small provider adapter and process-local cache over an agent
framework or database-backed cache. Revisit shared caching when redundant searches
across many instances dominate cost; extend the identity map when unknown vendors
regularly need official-source prioritization. The deterministic fake provider
keeps ordinary tests independent of API keys and paid searches.

## 6. Latency choices

Step 9 establishes the frontend foundation with shared CSS tokens for both
themes, a 260px collapsible sidebar and a content column capped at 720px.
The page and initial shell render on the server; only sidebar state and the
appearance controls need client interactivity. Geist handles UI text, Source
Serif 4 handles content at 17px/1.65, and Geist Mono handles code. `next/font`
self-hosts and preloads the Latin subsets with adjusted fallback metrics and
`display: optional` to avoid late font swaps moving content.

An inline script in the document head applies the saved light/dark/system choice
before content paints. A CSS media-query fallback also follows the system theme
with JavaScript disabled. The appearance control subscribes to system changes
and storage events, persists manual choices when storage is available, and
continues to work in memory when storage is blocked. Theme changes affect color
tokens without changing layout geometry. The foundation includes keyboard focus,
a skip link and reduced-motion rules. Below 768px the sidebar is hidden; the
mobile history drawer remains part of Step 12.

Step 6 assembles two system text blocks: persona, policies and curated memory
form the stable prefix marked with ephemeral `cache_control`; the clock,
timestamped original turns, claims, resolved/missing dates, hints and thread
summaries form an uncached suffix. Actual cache hits depend on the provider's
minimum prefix size and reuse; the code does not pad the prompt to force them.
Only the current message becomes a new user request. Historical content is
escaped JSON inside explicit data boundaries.

The agent uses the SDK's native
[`messages.stream` and `finalMessage`](https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript)
helpers, with a hand-written loop and no framework. Defaults are four model calls,
ten search queries, 2,048 output tokens per model call, and a 45-second wall-clock
cap with five seconds reserved for the final response. A separate injected
monotonic timer in `lib/clock.ts` advances even when `NOW_OVERRIDE` fixes calendar
time. Timeouts abort active model streams or searches. SDK automatic retries are
disabled so retries cannot silently consume the turn's budget.

The final allowed call uses `tool_choice: none` while retaining the same single
tool definition. This disables search and preserves the tool/system cache prefix
where possible, as described in the
[tool caching rules](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching).
Query batches that exceed the remaining quota are trimmed explicitly; skipped
queries appear as tool errors in the result. Every tool result is capped before
it enters the next model request, and source events contain only retained
evidence. These bounds favor an honest partial answer over an unbounded research
loop; revisit them only for an explicit longer research mode.

Anthropic remains the default answer provider; Google AI Studio is available
through the native Gemini transport. Startup requires the selected provider's
key plus TAVILY_API_KEY. Both transports share the handwritten agent loop and
its single web_search tool. The provider-neutral SSE data parser lives in
lib/agent/sse.ts; Gemini does not depend on another provider's adapter.

Explicit live-score and web-lookup requests require `web_search` on the first
step using the provider's forced tool choice. Definitions, code requests and
explicit browsing opt-outs retain normal routing. Final/recovery steps keep
tools disabled. The model still has exactly one available tool.

Live-score intent includes “score today/now”, while definitions and explicit
browsing opt-outs retain normal routing. The loop forces the initial lookup,
allows at most two search passes and reserves ten seconds for synthesis within
the existing four-step, ten-query and 45-second limits. A late tool request can
receive one paired refusal and a final repair within those same limits.

Gemini synthesis omits tool declarations and converts completed function exchanges
to ordinary text, retaining escaped evidence wrappers and dropping private thought
parts/signatures. This avoids the reproduced behavior where a request marked NONE
still returned another function call. Final synthesis uses low thinking effort.
Research still preserves exact native signatures for genuine tool continuations.

Live searches bypass local caching, request Tavily max_age_hours=0 with three
deep results and retain a retrieval timestamp separate from the source's update
time. Live queries preserve provider relevance instead of ranking dated articles
above undated scorecards. Videos, watch-alongs and streaming/fantasy promotions
are excluded from score evidence; schedules cannot establish that play has begun.
Missing final synthesis retains bounded, escaped and clearly unverified source
excerpts. The opt-in search:live-smoke reproduces the exact short score-today query
using real providers, with no database or curator calls; normal tests remain offline.

Research effort is a validated per-request enum, defaulting to medium at the API
boundary and remembered locally by the composer. Instant/medium/high cap queries
and distinct sources at 2/5/10, with 30/45/90-second wall budgets. Instant reserves
eight seconds for finalization and moves to synthesis after its first search pass;
medium reserves ten seconds, high fifteen. Both retain the four-step ceiling
(instant uses three) and the live two-pass limit. The Node route allows 120 seconds
to accommodate High plus persistence and curation. Source selection shares the
budget fairly across queries, counts duplicate URLs once and retains earlier
evidence across batches. Only selected sources enter model context, events and
curation. Effort maps to low/medium/high native Gemini thinking and Anthropic
output_config.effort; the internal request marker is never sent to a provider.

The calendar context derives the local ISO day, named-month date, weekday and
local time from the injected clock. Unambiguous numeric date literals normalize
to ISO; ambiguous day/month alternatives and invalid calendar dates are surfaced
for clarification. URL path segments are not interpreted as requested dates.
The same normalization protects recall and provider publication dates. Ambiguous
history dates cannot accidentally fall through into an all-history inventory.
Explicit future references retain their year, and upcoming-event parsing is
separate from historical recall's most-recent-occurrence bias.

Sports intent includes match/fixture-today requests. Sports answer text is held
until the complete reply can be reviewed for the reproduced no-match-today versus
finished-earlier-today contradiction, or an explicit today/date/weekday mismatch.
One text-only repair uses the same evidence, clock and existing request budget;
the rejected draft is never streamed or persisted. A repeated failure returns
clearly unverified source excerpts. Ordinary chat retains incremental streaming.
Offline regressions cover both numeric date orders, ambiguity, invalid days,
UTC/India/New Zealand boundaries, future dates and the exact contradictory reply.
The opt-in Instant match-today smoke checks the exact user request with real
providers, at most two queries/sources, and no chat or curation writes.

## 7. Failure modes and honesty

Step 6's typed events and SSE encoder share the five-event contract: `status`,
`delta`, `sources`, `error`, `done`. `runAgent` owns this event lifecycle, including
one terminal `done`; the later route must close its stream without emitting a
second completion event. Search status always transitions from running to done,
including failures and cancellation. The loop returns assistant text, model and
query counts, source metadata, timing and unverified-query lists for persistence
and tracing in Step 7.

Invalid tool input and any tool name other than `web_search` return paired tool
errors without executing another capability. Partial search failures preserve
successful queries. Model failures emit a sanitized error and retain every text
delta already sent. A stalled research stream leaves time for a tools-disabled
final answer; a stalled final stream still terminates with an honest error and
partial response. After sources have been fetched, a recoverable model tool-generation,
network, stream or availability error allows one tools-disabled final attempt using
the existing evidence, capped at 512 output tokens. A rate limit permits this only
with a numeric Retry-After that fits the remaining wall-time and step budgets.
Authentication, rejected requests and unknown failures are not retried; searches
are never repeated by recovery. Terminal errors distinguish provider problems
from a completed search, without exposing provider bodies. Live scores require
a current score and match timestamp; an unsuccessful lookup must remain explicit.
Budget disclosures list completed searches and failed or
omitted queries, without equating a successful search with verification of a
claim. Caller cancellation stops further work; a broken output sink is contained
and cancels the run.

The prompt requires sources dated strictly after old claims for both unchanged
and changed verdicts, and treats undated, stale, ambiguous and future evidence as
unverifiable. Search content and all recalled context remain data, never new
instructions. Prompt policies guide evidence interpretation; the Step 5 parser
and date gate remain available for explicitly selected comparable evidence.

## 8. Tradeoffs and revisit conditions

## 9. What was deliberately left out

## 10. Evals and reproduction

Run `npm test` for fixed-clock temporal cases in UTC, Asia/Kolkata and
America/New_York, including the six required phrases, missing dates, multiple
expressions, year/month boundaries and daylight saving transitions. Clock tests
cover override validation, offset normalization, the default timezone and the
system-clock fallback. The end-to-end eval harness is planned for Step 13.

Storage integration tests use isolated databases on the disposable Docker Postgres
test service and verify generated search
vectors, the GIN index, date boundaries, keyword ranking, cross-session recall,
user isolation, constraints, migration reruns and persistence across reopening.
Separate tests check Postgres driver selection and cleanup using a mocked pool,
and ensure Node startup waits for initialization and propagates failures. A live
hosted Postgres connection still requires deployment credentials.

Search tests use fake providers and injected fetch/clock functions to cover
parallelism, concurrency limits, cache keys and expiry, timeout fallback,
cancellation, partial failures, URL deduplication, official-domain boundaries,
publication dates, wrapper escaping, output budgets and provider request mappings.
`npm run search:smoke` is an explicit live check: exactly two basic Tavily queries,
without automatic retries, fallback or deep extraction. It loads development env
files (including `.env.local` and `.env`) and prints result titles and URLs. The
live check passed during Step 4 implementation; ordinary `npm test` never invokes
it or consumes search credits.

Claim comparison and query-hint tests were written before their implementations.
They cover exact prices, unit and currency compatibility, billing commitments,
decimal precision, storage conversion, version normalization, booleans and
negation, ambiguous/missing evidence, dated-verdict gates and deterministic hints
across a local New Year boundary. Run them without API calls using
`npm test -- lib/recall/diff.test.ts lib/recall/hints.test.ts`.

Step 6 tests cover parallel recall, keyword fallback and its provenance, original
turn/claim budgets, cached-prefix stability, timestamped context and missing
history. Fake-model tests assert the single search batch, tool-result IDs, exact
SSE payloads, step/query/time/output budgets, tools-disabled finalization, partial
errors and cancellation. One test uses the real Anthropic SDK parser with a
mocked SSE HTTP response; another verifies recall against an isolated Docker Postgres database.
These checks do not invoke paid model or search APIs. API routes, session cookies,
turn persistence and pino turn traces are implemented in Step 7.

Step 7 integration tests exercise chat and history against real Docker Postgres with fake
model streams. They check immediate/deferred persistence, exclusion of the new
turn from recall, follow-up context, cancellation, private user/session scopes,
pagination with timestamp ties, request bounds, rate limits and one trace per
turn. Mocked Gemini SSE tests cover byte-fragmented content, signed function calls,
paired results, incomplete streams and safe errors. Provider configuration tests
verify the selected provider's key requirements. Normal tests never make paid provider calls.

Step 8 tests seed the five-CRM shortlist against real Docker Postgres and confirm that its
claims reach the recall prompt and suggested revalidation queries. They cover
duplicate/concurrent passes, quote and URL provenance, invalid output, dated
supersession, memory corrections, thread merges, user isolation, rollback,
restart persistence, delayed retries and persistent failures. SDK tests use a
mocked HTTP response to verify Haiku structured JSON without tools or paid API
calls. Gemini tests verify provider selection without an Anthropic key, native
JSON schema configuration, cancellation, invalid/truncated/blocked responses and
retrying extraction into real Docker Postgres. Route tests confirm extraction follows persistence and streaming, failures
preserve history, and the next message can proceed while the curator runs.
Run `npm test -- lib/curator test/api.test.ts lib/store/store.test.ts`.

Step 10 adds a POST/fetch `ReadableStream` client with incremental SSE framing,
UTF-8 decoding and Zod validation for all five event types. Split CRLF sequences,
multiline data, comments and fractional performance timings are supported. Known
malformed events and premature EOF become inline errors; earlier valid deltas
are retained even when a later frame in the same chunk is malformed. A terminal
`done` ends consumption and releases the reader. Unfinished frames are bounded.

Conversation state is a pure reducer. Request IDs prevent late callbacks from a
stopped request changing its successor. Text deltas batch once per animation
frame, and Stop flushes that buffer before aborting fetch. Unmount also aborts
the active request. The composer grows to 200px, adjusts when its width changes,
and supports Enter, Shift+Enter and IME composition. Assistant replies use
`react-markdown`/GFM with raw HTML disabled and the default safe URL transform.
Code blocks expose a copy control; model-provided images do not initiate remote
browser requests. User messages remain plain text.

The message viewport follows content and composer resizing until the user scrolls
up. Browser scroll anchoring is disabled so it cannot fight this policy. A jump
control resumes following. The scroll area is keyboard-focusable, and the live
log defers announcements while a response is in progress. Status, source and
timing metadata are retained for Step 11's richer components.

Step 9 browser checks cover light/dark desktop rendering, a persisted theme after
reload, sidebar collapse/expansion, and a 375px-wide layout without horizontal
overflow. The 720px content column has identical geometry in both color themes,
and the browser confirms all fonts are loaded. Automated checks include the
existing 264 tests, TypeScript, frontend lint and the default production build.

Step 10 adds 17 deterministic parser/state tests, bringing the suite to 281.
Browser checks verified streaming, code copying and Stop preserving
partial text. Remaining checks used a temporary local SSE fixture, without model
or search calls or database writes: scroll hold as content grew, jump-to-latest,
HTTP failures, interrupted responses, both themes and a 375px layout. The fixture
was removed after verification. Step 11 adds a browser-local demo rather than a
fake server endpoint.

Step 11 renders the existing search/source events without changing the SSE
contract or the model-facing tool. Search details stay collapsed by default,
list every query and report result counts per batch, matching the available
metadata. Pending searches become stopped/incomplete when the response stops or
fails, so their running indicators do not pulse indefinitely. Empty results are
explicit and are never presented as a successful verification.

Source chips derive their displayed host from the validated HTTP(S) link, reject
credentials and unsafe protocols, and show official markers only from server
metadata. Focus or hover reveals a source title and publication date; Escape
dismisses the card. Missing dates have an explicit label and failed favicons fall
back to a globe. Native favicon images use no referrer and fixed dimensions.

The markdown plugin styles explicit verdict labels and valid absolute as-of
dates, including bold labels, headings, table cells and labelled paragraphs.
It never infers a verdict from prose, missing evidence or a price. Code, links,
quoted passages and raw HTML are excluded from annotation. Dates are validated
and formatted deterministically in UTC through `lib/clock.ts`; relative or
invalid dates stay as text. Icons and readable labels accompany every verdict.
The underlying claim comparison and dated-evidence requirements remain unchanged.

`/demo` contains a gallery of running, completed, empty, stopped and interrupted
searches, official/ordinary/undated sources, favicon fallbacks, all three verdicts
and date chips. Its streamed scenarios use an in-browser `ReadableStream`, the
real SSE parser, reducer and chat components. They make no fetch calls, use local
favicons and do not persist conversations. Stop/reset/unmount cancel the fixture
timers. No API keys, environment flags or extra API endpoints were added.

Step 11 adds 25 tests covering date/URL validation, status summaries, safe
markdown annotations and actual React rendering, plus all four demo scenarios
and cancellation with fetch stubbed. These fixtures require no paid API calls.

Step 12 adds real saved-conversation navigation, new chats, local-calendar groups
(Today / Yesterday / Previous 7 days / Older), pagination, title filtering of
loaded history, and browser-persisted pins. Opening a conversation fetches its
latest saved messages; every POST explicitly identifies its session, so New chat
does not accidentally continue the old cookie session. Sidebar navigation is
disabled during streaming; Stop remains available. The mobile drawer uses the
native dialog's focus containment, Escape handling and background inertness,
returning focus to its trigger. Offline status prevents accidental sends while
preserving the current draft. Failed responses and history/model loading have
inline retry actions. Pure helpers test local dates across DST, greetings and
merging overlapping history pages without duplicate turns.

The product is branded **Chrona**, reflecting time-aware conversational recall.
Its empty state has a clock-derived greeting and a vertically centered prompt;
the same composer moves to the bottom once messages exist. At the user's request,
the starter chips and visible Enter/Shift+Enter hint were removed; keyboard
behavior is unchanged. The center book icon was removed. Sidebar branding,
assistant labels and browser metadata use Chrona and the supplied cat mark.
Existing storage identifiers remain compatible so the rebrand retains history,
pins and model choices. `public/chrona-logo.png` is the transparent asset prepared
with the built-in image editing tool. Final edit prompt: “Remove only the white
background and excess blank margins; preserve the supplied stretching cat's
pose, expression, proportions, colors, fur shapes, brown outline, pink ears and
mouth; keep the full tail and paws, a small transparent margin, and no shadow,
text or border.” The generated file was copied into the project; its alpha is
preserved. Next Image serves small optimized instances, and the favicon uses the
same mark.

The prompt's compact model button opens a themed popover with descriptions and
a selected checkmark. Its More models section accepts a provider and validated
model ID. `GET /api/models` publishes IDs and availability only. Each chat POST
can include `{ selection: { provider, model } }`; validation and provider-key
checks happen before persistence or model calls. The selection follows the turn
through answer generation, tracing and background curation. Keys stay server-side;
model preference is browser-local and cannot override authentication or endpoints.
Configured defaults are `ANTHROPIC_MODEL` and `GEMINI_MODEL`.

Google AI Studio uses the native Gemini Developer API with
`GEMINI_MODEL=gemini-3.5-flash-lite` and `GEMINI_API_KEY`, matching the
[official model ID](https://aistudio.google.com/docs/models/gemini-3.5-flash-lite).
The handwritten SSE adapter exposes only web_search, respects forced/disabled
function choice, sanitizes failures, supports cancellation, and keeps thought
text out of the public stream. It retains exact native response parts and
function IDs for the current run, including encrypted thought signatures;
the [signature requirement](https://aistudio.google.com/docs/thought-signatures?generate-content=true)
requires native Gemini request conversion. Signatures are
neither persisted nor displayed. Gemini curation uses native schema-constrained
JSON and the same local extraction/evidence validation. Mocked tests cover
fragmented SSE, signature/ID replay, provider selection, rejected requests,
cancellation and malformed/blocked responses. A bounded live validation used two
Gemini requests and a synthetic search fixture, with no search-provider,
curation or persistence calls; both returned HTTP 200 and a dated fixture answer.

The last successful model step completes normally without a spurious step-limit
warning. A regression test reproduces two search batches, a failed stream and a
fourth-step recovery with assembled policy/recall context, asserting retained score
evidence, paired function IDs and one terminal completion. The four-step,
ten-query and wall-time limits remain enforced.

History inventories are deterministic answers, not model inference. The old
date path fetched the earliest 100 turns and then fit complete user/assistant
pairs into a small recall budget. Long assistant replies could leave only the
morning's questions. A
pure intent/date helper now routes unqualified inventories of the user's own
questions/messages to a dedicated user-only query. Reverification, topic filters,
time-of-day filters and mixed requests retain the ordinary model path.

The query is user-scoped across sessions, uses local-day UTC bounds and descending
timestamp/ID keyset pages, and takes a snapshot before the current user turn.
It reads fresh data for every request, excluding assistant text, other users,
future rows and the request itself. Up to 1000 recent messages can be loaded;
the deterministic renderer orders the selected entries chronologically, uses
the injected timezone, escapes stored Markdown, and discloses long-message or
response-budget truncation. Multi-day lists include calendar dates. It emits the
same SSE contract, persists the answer, and skips both generation and curation,
so Anthropic and Gemini selections have identical history-list behavior with no
provider cost. Tests cover more than 100 saved turns, multiple DB pages, fresh
later messages, local midnight/DST, timestamp ties, tenant isolation, omission
disclosure and both provider selections with real Docker Postgres.

Conversation deletion uses a native confirmation dialog and an idempotent Node
DELETE endpoint. One transaction removes only the user's selected session and
its source-linked claims, memory, threads and curation jobs; references to removed
claim versions are cleared on the user's surviving baselines. The transaction
shares the curator's per-user advisory lock, preventing delayed extraction from
recreating deleted notes. Active responses are protected by the shared request
admission lease. Failure rolls back the whole deletion. The client removes pins,
filters stale in-flight history pages and opens a new session when the current
one is deleted. Tests verify ownership, retained chats/users, FK rollback,
late-curation rejection and endpoint validation/admission/error sanitization.
