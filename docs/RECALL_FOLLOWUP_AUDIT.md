# Collection follow-up and midnight-context audit

Audited 16 November 2026 using read-only saved records, the supplied screenshots,
and the current implementation. No saved conversation text was rewritten.

## Confirmed failures

1. The actual follow-up was “lemme know the 6 messages” (user turn 351), after
   summary turn 350 selected six messages for local 16 November. The persisted
   recall reference had an empty source list and no collection provenance. Empty
   queries plus a missing date were then treated as an unrestricted inventory,
   producing eighteen messages across two days. This was lost reference scope,
   not evidence that the local-day SQL predicate failed.
2. User turn 337, “recheck again for today,” was included among the six messages.
   It belongs to the same session as turns 333 and 335 about film post-credit
   scenes from the previous local day. The summarizer received only selected
   message text, without that session's earlier context. It mislabeled the subject
   as today's messages and combined six distinct requests into one catch-all
   item. The record was selected; its meaning was lost during synthesis.

The record timestamp for turn 337 is 15 November 2026 at 22:36:41.862 UTC,
which is 16 November at 04:06:41.862 in Asia/Calcutta. The local 16 November
selection spans 15 November at 18:30 UTC through 16 November at 18:30 UTC
(exclusive). Each message's timestamp determines membership. Its session's
start date does not determine membership.

## Implemented correction

- Use a single structured intent plan. Remove the separate regex inventory
  shortcut and explicitly distinguish a new collection, a previous collection,
  all history, and topical recall. Missing references/dates cannot grant all-history
  access. Current explicit dates remain constraints even if the model omits them.
- Persist exact displayed collection IDs, absolute date bounds, timezone,
  session scope, original cutoff and truncation atomically with the answer.
  Rehydrate only those originals for collection follow-ups, including after
  midnight. Do not include the summary request, later messages or older topics.
  Missing/deleted sources require a new scoped request.
- Supply bounded earlier same-session user context for each selected message.
  It can cross midnight to explain an elliptical continuation but cannot become
  a selected-day message, count, or evidence ID. Recheck both selected records
  and contextual records after inference.
- Require one summary item per selected message, rejecting multi-source catch-all
  items. Each item has a scalar `turnId`; live checks showed that an array with a
  one-element size constraint still allowed grouped IDs from Gemini. The executor
  may combine identical originals with identical summaries after coverage checks.
- Preserve deterministic timezone conversion, strict timestamp/ID cutoffs,
  ownership, dates, counts and pagination. “Now” as an adverb does not reset a
  referenced collection. Unsupported sub-day/interval constraints ask for
  clarification instead of broadening silently.

## Plan versus another tool

Retain tool-free structured planning plus the deterministic executor. A model
cannot reliably replace SQL ownership, local midnight boundaries, provenance,
deletion checks or exact counts. Another recall tool would still need all of
those guarantees and would conflict with this repository's single `web_search`
model-facing tool contract. The defects were incomplete state/context contracts,
not a need for an agent framework or another exposed tool.

Live Gemini checks passed for exact collection references, contextual midnight
continuations, broad recap planning, repeated-message coverage, topical recall,
decoy rejection and timestamp follow-ups. They use synthetic messages and perform
no conversation or curation writes. Anthropic was not configured for live checks.
The source suite includes real isolated Postgres tests across different years,
timezones, local midnight, missing/deleted sources and a deliberately omitted
planned date. TypeScript, lint and deterministic evaluation checks also cover
the shared executor.

## Compatibility and limits

Migration 5 adds nullable collection metadata without changing saved messages.
Old summaries lack recoverable exact source provenance; request the day again
once to create a verified collection. Existing erroneous assistant text remains
historical text. Source-ID coverage and contextual provenance do not prove
paraphrase correctness, so live-provider checks complement deterministic tests.
Large histories and contexts remain explicitly bounded; unresolved references
must stay uncertain rather than acquire an invented topic.
