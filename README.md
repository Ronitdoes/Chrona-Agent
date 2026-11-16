# Chrona

A time-aware research assistant that recalls original conversations and checks
historical answers against fresh, dated evidence. Built with Next.js, TypeScript,
Postgres and a handwritten model loop exposing one tool: `web_search`.

Run the commands below from the repository root. Detailed project documentation
lives in [`docs/`](docs/ARCHITECTURE.md).

## Run locally

Use Node.js and Docker Desktop with the Linux engine running. Node 24 is the
configuration used by the clean-install verifier. Next.js runs on the host;
Postgres runs in Docker.

Copy `.env.example` to `.env.local`. Set `BETTER_AUTH_URL` to your app origin.
Generate independent secrets for `BETTER_AUTH_SECRET` and `API_KEY_ENCRYPTION_KEY`
using the commands in the example file. The encryption key must contain 64 hex
characters. Preserve it across restarts and database restores.

Keep the example `DATABASE_URL` for the local database, then run:

```bash
npm install
npm run db:up
npm run dev
```

Open [localhost:3000](http://localhost:3000), create an email/password account,
and connect one LLM key and one search key in API keys settings. Migrations run automatically before
the server handles requests. Missing or invalid database configuration fails
startup; there is no embedded database fallback. Restart the server after
changing environment settings. Personal provider key changes apply on the next request. `.env.local` takes precedence
over `.env`; avoid conflicting values. Never commit either private file.

For a production server on the host, keep Postgres running and use:

```bash
npm run build
npm start
```

Hosted Postgres is supported through `DATABASE_URL`. The repository does not
include a production application Docker image or hosting deployment automation.

## What the app supports

- Email/password signup, sign-in and sign-out with account-owned history and
  encrypted personal Anthropic, Gemini, Tavily and Exa keys.
- Private `/chat/[sessionId]` links with refresh and browser navigation.
- Tavily/Exa selection in the effort popup, with automatic fallback to the other
  configured provider and query-level fallback status.
- General research with source cards, search progress, streaming answers and
  bounded recovery after provider failures.
- Conversation inventories rendered directly from user-message records, without
  model, web-search or curator calls.
- Evidence-backed history questions and timestamp follow-ups using original
  user messages. Summaries and assistant assertions cannot prove what was asked.
- Mixed history/research answers with separate private-history and external
  evidence sections. Missing history and undated evidence remain explicit.
- Saved conversations, local-day grouping, pinned chats, title filtering over
  loaded history, older-page loading and confirmed conversation deletion.
- Anthropic and Google AI Studio model selection, including custom model IDs.
  Keys remain on the server; each selected provider needs its own key.
- Light, dark and system themes; a mobile navigation drawer; offline notices and
  retries. Draft text remains editable when offline.
- Lenis scrolling across conversation, history, demo, picker and dialog panels.
  Scrollbars are hidden while overflow, keyboard navigation, native touch,
  reduced-motion behavior and Jump to latest remain available.

Research effort is remembered in the browser and can also be supplied by API:

| Effort | Search queries | Sources | Answer-model calls | Research and context budget |
|---|---:|---:|---:|---:|
| Instant | 2 | 2 | 3 | 30 seconds |
| Medium (default) | 5 | 5 | 4 | 45 seconds |
| High | 10 | 10 | 4 | 90 seconds |

The effort popup also provides **Answer detail** with Auto (default), Brief and
Detailed. The preference is saved in the browser separately for each account.
Auto follows the question, Brief favors compact answers, and Detailed develops
explanations with relevant background, examples and citations. Explicit prompt
instructions about length, word count or format take precedence.

Answer generation receives additional time independently of the search limits.
Brief adds up to 30 seconds, Auto adds up to 120 seconds, and Detailed adds up to
240 seconds to the final-answer reserve and total request deadline. These are
maximum allowances. An ordinary short response returns as soon as it completes.
The Node chat route permits up to 360 seconds. Hosting must support that duration.

`gemini-3.5-flash-lite` requests use its documented 65,536-token output ceiling,
and Gemini counts thought tokens against that same ceiling. Other model IDs use
a conservative 8,192-token allowance. Prompt instructions control actual answer
length within this ceiling. Long output is streamed in Unicode-safe chunks, and
token/time exhaustion is reported with partial text preserved. A provider-failure
recovery uses a bounded 8,192-token allowance with reduced thinking, so thought
tokens cannot consume the recovery answer before its text is written.

These are limits, not promised source counts. Planning and recall share the
research/context time budget; their inference calls are separate from answer-model
calls. A single search batch can contain several queries. Live-score lookups
bypass the search cache, request fresh page content and allow at most two search
passes. Dates use the requested timezone, and ambiguous numeric dates require
clarification.

## Database operations

| Command | Effect |
|---|---|
| `npm run db:up` | Start Postgres and wait for its health check |
| `npm run db:stop` | Stop the application database |
| `npm run db:down` | Remove Compose containers/network while retaining the application volume |
| `npm run db:logs` | Follow application database logs |
| `npm run db:test:up` | Start the separate disposable test database service |
| `npm run db:test:down` | Stop and remove the test container |

Application Postgres 18 binds to `127.0.0.1:5432` and uses a named volume. Test
Postgres binds to `127.0.0.1:5433` and uses disposable storage. Compose credentials
are local-development defaults, not production secrets. `docker compose down -v`
deletes the application volume; use it only when a reset is intended.

The local migration from the former embedded database retained the original
files, a filesystem backup, a text export and a verification report under ignored
`data/`. No embedded driver or dependency remains. `lib/store/transfer.ts` imports
saved schema-version 1–4 snapshots into an empty, migrated Postgres target,
verifies transferred fields and search data, and commits rows and sequence resets
together. Stop application writes during a transfer. Exports and backups contain
private conversation data and must remain uncommitted.

## Configuration

[`.env.example`](.env.example) is the complete configuration reference; `lib/env.ts` validates
application configuration with Zod.

| Variable | Purpose |
|---|---|
| `MODEL_PROVIDER` | Default provider: `anthropic` or `gemini` |
| `ANTHROPIC_API_KEY` | Optional Anthropic CLI/evaluation key |
| `ANTHROPIC_MODEL` | Anthropic answer model; default `claude-sonnet-5-5` |
| `GEMINI_API_KEY` | Optional Gemini CLI/evaluation key |
| `GEMINI_MODEL` | Gemini answer model; default `gemini-3.5-flash-lite` |
| `TAVILY_API_KEY` | Optional Tavily CLI/evaluation key |
| `EXA_API_KEY` | Optional Exa CLI/evaluation key |
| `BETTER_AUTH_URL` | App origin, default `http://localhost:3000` |
| `BETTER_AUTH_SECRET` | Required authentication secret, at least 32 characters |
| `API_KEY_ENCRYPTION_KEY` | Required independent 32-byte hex key |
| `DATABASE_URL` | Required PostgreSQL URL; use the example for local Docker |
| `TEST_DATABASE_URL` | Test service URL; the harness defaults to the isolated local service and rejects unsafe overrides |
| `DEFAULT_TZ` | Timezone fallback; default `Asia/Kolkata` |
| `NOW_OVERRIDE` | Evaluation calendar override: ISO timestamp with `Z` or an explicit offset |

## Tests, evaluations and shipping verification

```bash
npm run db:test:up
npm test
npm run eval
npm run typecheck
npm run lint
```

Each database-backed suite uses its own uniquely named database on the test
service. Tests never use `DATABASE_URL` for destructive cleanup. Generated
snapshots under `data/` are excluded from test discovery, TypeScript and lint.
Normal tests and deterministic evaluations make no paid provider requests.

`npm run eval` exercises the production chat handler, real Postgres, fixed dates,
recorded model responses and synthetic dated search evidence. It covers the CRM
shortlist, the 3 November question/answer, the Tuesday hosting comparison, missing
history and query-budget exhaustion. It prints pass/fail results, recall time,
time to first answer text, tool-call count, query count and total response time.
Recorded-model timings measure local orchestration, not provider speed or model
accuracy. Reference measurements and limits are in [DESIGN.md](docs/DESIGN.md).

Live checks are explicit opt-ins and may incur provider charges:

| Command | Coverage |
|---|---|
| `npm run eval:live` | Configured recall and answer models on an explicitly fictional hosting fixture; synthetic search |
| `npm run recall:live-eval` | Recall planning, timestamp follow-ups, mixed intent and semantic decoys; no database writes |
| `npm run search:smoke` | Two real Tavily queries |
| `npm run search:live-smoke` | Real Gemini/Tavily sports date and verification checks; no conversation writes |

For independent installation and runtime verification:

```bash
npm run ship:verify
```

This creates a source-only working-tree snapshot and runs it in fresh Linux Node
24 and Postgres 18 containers. No private environment files, host database,
`node_modules` or `.next` output are copied. It verifies dependency installation,
dev startup, HTTP chat/history, production build, typecheck, lint, tests, all three
sample-prompt evals and persistence across dev/production restart. HTTP smoke
requests use the deterministic history path, so real provider keys are not
needed. Docker and network access for images, packages and build-time fonts are
required. Verification containers and their database are removed automatically;
the source snapshot and result report remain under ignored `data/ship-check/`.

The latest recorded validation includes 570 source tests, five deterministic
eval cases, a passing restricted Gemini live fixture, and clean Linux snapshot
verification. After the Lenis UI change, typecheck, lint and the normal Turbopack
production build passed; browser checks covered desktop, 375px mobile layout,
menus, keyboard access, streaming auto-follow and reading-position preservation.
These are bounded regression checks, not a production accuracy benchmark.

## API and local demo

| Route | Contract |
|---|---|
| `POST /api/chat` | JSON `message`, required owned UUID `sessionId` and `searchProvider`; optional `tz`, `selection: { provider, model }`, and `effort`; returns SSE |
| `GET /api/history` | Optional `sessionId`, `tz`, `limit` (1–200) and opaque `before` cursor; returns grouped sessions and `nextCursor` |
| `DELETE /api/history?sessionId=<UUID>` | Confirmed, user-scoped conversation deletion; successful deletion returns 204 |
| `GET /api/models` | Model IDs and account provider availability; never API keys |
| `POST /api/conversations` | Creates an owned conversation with a server UUID |
| `GET /api/credentials` | Configured-provider status only |
| `PUT /api/credentials` | Saves or replaces an encrypted personal provider key |
| `DELETE /api/credentials?provider=<provider>` | Removes the account’s key for that provider |
| `/api/auth/*` | Better Auth email/password signup, sign-in, session and sign-out |

Better Auth database sessions authenticate private pages and APIs. SSE
events are `status`, `sources`, `delta`, `error` and `done`. `X-Session-Id`
identifies the conversation; `X-Turn-Id` and `done.turnId` identify the request.
See [runtime architecture](docs/ARCHITECTURE.md) for persistence and evidence flow.

[The component demo](http://localhost:3000/demo) replays comparison, empty-result,
interrupted-search and slow-response scenarios. Its data, sources and dates are
fictional; it makes no model/search requests or conversation writes.

## Documentation

- [Design decisions](docs/DESIGN.md): rationale, alternatives, UI behavior, tradeoffs and measured limits.
- [Architecture](docs/ARCHITECTURE.md): current components, interfaces and data flow.
- [Conversation recall](docs/MEMORY_RECALL.md): evidence rules, retrieval bounds and follow-up references.
- [Historical recall audit](docs/MEMORY_AUDIT.md): pre-remediation findings and current resolution status.
- [Contributor instructions](AGENTS.md): repository constraints and maintenance rules.

## Account security and operations

Passwords require 12–128 characters. Signup grants immediate access. This release
provides no email verification or password-reset email delivery. Auth attempts are
rate-limited in each server process. Deploy behind HTTPS with a stable
`BETTER_AUTH_URL`; mutation origins must match it. Private API access requires a
Better Auth session. Legacy anonymous cookies grant no access, and existing
anonymous records stay in Postgres without being assigned to accounts.

Provider keys are encrypted with AES-256-GCM and bound to their account and
provider. Settings expose configuration status only. Replacing or removing keys
affects subsequent requests; already-running requests finish with their captured
credentials. Removing the last LLM or search key disables sending while history
remains readable. Back up the encryption key separately from Postgres. Changing
it requires re-encrypting credentials or asking users to reconnect keys.

Environment provider keys are optional inputs for CLI smoke tests and live
evaluations. Web requests always use the signed-in account's keys. A failed search
can charge the other configured search provider when fallback runs.

On hosts where Turbopack cannot spawn its loader process, the equivalent build
uses the same Tailwind loader through webpack. Run `npx next build --webpack`,
then `npm start`. Development can use `npm run dev -- --webpack`.
