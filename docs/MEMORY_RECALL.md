# Evidence-backed conversation recall

Implemented 15 November 2026 following [the hallucination audit](MEMORY_AUDIT.md).

Requests outside the existing deterministic message-inventory shortcut first use
a small structured inference call with the selected provider. It classifies
general, history-only and mixed requests, extracts topical query variants and
exact user date phrases, and resolves references using bounded recent context.
This adds an inference call to ordinary turns. The planner exposes no tools;
the answer loop still exposes exactly one tool, `web_search`.

History-only questions bypass answer generation and web search. A bounded service
retrieves original user messages, asks for semantic evidence selection, checks
IDs and quotes against the returned originals, rechecks ownership and deletion,
and renders the answer directly from stored quotes and timestamps. Summaries,
memory facts and past assistant assertions are never evidence candidates.

The source IDs are saved atomically with the answer in `recall_references`.
Follow-ups such as “at what time?” rehydrate those same original user messages;
missing/deleted sources produce uncertainty. Only the most recent assistant
answer in that session can supply an antecedent. Failed or ambiguous recall
records an empty source set rather than resurrecting an unrelated older answer.
History-only recall requests are excluded from subsequent topical searches, so
a question about remembering a request cannot self-confirm. Mixed requests
remain candidates because they can also contain a genuine new external request.

Mixed requests render the private-history section from records and send only the
fresh external subquestion to the existing research loop. Revalidation also
supplies bounded original baseline text. Summaries and prior recollection claims
are not replayed into that external answer. Generated mixed-answer text is
buffered until the loop completes. The semantic correctness of arbitrary external
prose continues to depend on the answer model and its evidence; this is not a
proof that every possible model response is hallucination-free.

History/recollection answers do not run through the curator, preventing these
answers from becoming new durable summaries or preferences. General research
retains its existing curator and recall path. Derived general-context memory and
thread summaries now retain source IDs in the prompt and are explicitly labeled
as hints, not proof of a prior question. The general recall budget is named in
bytes to reflect its actual accounting. History retrieval retains user messages
independently of the size of their assistant answers.

**Files:** `lib/recall/plan.ts` and `model.ts` implement structured interpretation;
`lib/recall/history.ts` handles evidence validation, scoped retrieval and rendering;
`lib/store/recall.ts` supplies the owned query helpers; `lib/chat.ts` orchestrates
the history and research paths. Append-only migrations 3 and 4 add references and
the request-kind flag. They run automatically through the existing store startup,
using the configured Docker or hosted Postgres connection. No new environment variables,
dependencies or model-facing tools are required.

**Limits:** topical retrieval uses the existing Postgres full-text index with up
to three AND-term query variants, not embeddings. It reads at most three pages
of ten user-message candidates and marks unchecked history explicitly. Dates
use tested local-day ranges from the injected clock. Long candidate messages are
shown as exact excerpts; model selections must refer to supplied excerpts.
Semantic matching still uses a model and can be mistaken. Exact quote membership
and valid ownership do not mathematically prove semantic entailment. Misses mean
no supported message was found in the searched scope, never that a conversation
did not occur. A planning/provider failure produces uncertainty rather than
falling through to an ungrounded answer or a public search.

**Time and traces:** planning, retrieval and synthesis share the user's chosen
effort budget. Recall traces include intent, operation, candidate/evidence IDs,
coverage and abstention reasons, without logging full messages or provider
credentials.

**Validation:** run `npm test`, `npm run typecheck` and `npm run lint`. Tests cover
the exact two-turn incident for both provider configurations and all three effort
modes, source deletion, same-timestamp cursors, user/session isolation, invalid
quotes/IDs, long assistant messages, ambiguous matches, missing dates, planner
failures, mixed requests, pagination and atomic persistence. Native Gemini and
Anthropic structured-output adapters are exercised with mocked HTTP responses.

`npm run recall:live-eval` is separate from normal tests and sends only synthetic
fixtures to providers with configured keys. It checks the screenshot request,
timestamp follow-up, mixed intent, and rejection of negated, quoted, hypothetical
and recall-question decoys. Gemini passed the live evaluation in this session;
Anthropic was skipped because its key was not configured. This small live fixture
set is regression evidence, not a broad production accuracy benchmark.

The normal production build was attempted inside and outside the sandbox. Both
attempts encountered a Turbopack CSS-worker process crash for
`components/workspace-background.css.css`; the recall code typechecks and the
automated tests pass. The CSS pipeline and UI assets were not changed for this
backend fix. The documented fallback, `npm run build -- --webpack`, passed,
including production compilation, typechecking and page generation.

The database connection persists across development reloads, while each new
store-module generation reruns pending migrations and rebinds current query
methods. Concurrent requests share that readiness promise. An old cached store
object therefore cannot hide newly added recall methods, and refreshing does not
open a second pool just to refresh query methods.

Recall deadlines round fractional monotonic durations down to positive integer
milliseconds before calling Node's `AbortSignal.timeout`. This prevents an
immediate RangeError on real requests; API regressions exercise fractional clock
increments as well as the fixed clock fixtures. The exact screenshot prompt was
also verified against the running local server using an isolated synthetic user,
and that test conversation was deleted afterward.
