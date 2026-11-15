# Chrona

A time-aware research assistant for historical conversations and present-day verification, built with Next.js.

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Backend and answer providers

The backend is available at `POST /api/chat` and `GET /api/history`. Copy
`.env.example` to `.env.local` and configure the answer provider plus `TAVILY_API_KEY`.
Leaving `DATABASE_URL` empty uses local PGlite with automatic migrations.

For Google AI Studio, use `MODEL_PROVIDER=gemini`, `GEMINI_API_KEY` and
`GEMINI_MODEL=gemini-3.5-flash-lite`. For Anthropic, keep
`MODEL_PROVIDER=anthropic`, set `ANTHROPIC_API_KEY`, and optionally change
`ANTHROPIC_MODEL`. Both providers expose exactly one tool, `web_search`. Never commit
your `.env` or `.env.local` file. Restart the dev server after changing provider settings.

The chat endpoint accepts `{ "message": "Hello", "tz": "Asia/Kolkata" }` and an
optional UUID `sessionId` and `selection: { provider, model }`. It returns SSE and sets HttpOnly anonymous identity and
conversation cookies. `X-Session-Id` identifies the conversation; `X-Turn-Id` and
the SSE `done.turnId` identify the request for tracing. History returns sessions
with turns grouped into local calendar days. It accepts `tz`, `sessionId`, `limit`
(1–200) and an opaque `before` cursor; `nextCursor` retrieves the next older page.
Anonymous cookies provide continuity, not account authentication. `GET /api/models`
returns model IDs and provider availability, never API keys. The model button in
the prompt box switches providers or opens **More models** for a custom model ID;
the choice is remembered in this browser. Providers need their own server-side key.

The sidebar supports new chats, saved conversations grouped by local day, pinned
chats, title search across loaded history, and loading older pages. On mobile it
opens as a keyboard-accessible drawer. The prompt is centered with a time-aware
greeting in a new chat and moves to the bottom once a conversation starts. Drafts
remain available offline, with inline retry actions after connection errors.

History inventories such as “what are all the questions I asked you today?” read
fresh user-message pages across conversations directly from the database. They
include local timestamps, exclude the current request, and do not call a model,
web search or curator. Lists keep recent entries and explicitly disclose any
response limit rather than presenting an early-day prefix as complete.

The trash action beside a conversation opens a confirmation dialog. Confirming
permanently deletes that chat and its source-linked claims, memory, thread notes
and extraction jobs. `DELETE /api/history?sessionId=<UUID>` is user-scoped and
idempotent; deletion is blocked during an active response. Deleting the current
chat opens a fresh one, and deleted chats are removed from this browser's pins.

After a successful search, a recoverable model failure can trigger one short
final-answer attempt from existing results within the same time and step budgets.
It does not repeat searches. Rate-limit recovery honors a numeric Retry-After;
otherwise the response explains the provider failure and preserves available
sources. Completing the last allowed model step successfully does not produce a
step-limit warning.
Explicit live-score requests and requests to search the web require `web_search`
on the first model step; the provider cannot silently skip that lookup.

Live-score lookups (including “score today”) bypass the app cache, request fresh
page content and stop researching after two search passes. Gemini's final pass
uses plain evidence text with no callable tools. Missing timestamps, unavailable
scoreboards and conflicting sources remain explicit; video promotions and
predictions do not establish a live score. `npm run search:live-smoke` is an opt-in
check using real Gemini and Tavily requests, with no chat or curation writes.

The composer's **Research effort** control remembers Instant, Medium (default)
or High for this browser. Instant aims for 1–2 sources with at most 2 search
queries; Medium aims for 4–5 sources with at most 5 queries; High aims for 9–10
sources with at most 10 queries. Limits apply across the entire turn, including
follow-ups, and sources are capped before they reach the model. Simple questions
can finish earlier and unavailable sources are never invented. Effort also sets
native model reasoning and response budgets. High allows up to 90 seconds;
Instant and Medium allow 30 and 45 seconds. API callers can send
`effort: "instant" | "medium" | "high"` in their chat request.

Dates use a named month, such as **15 November 2026**, and “today” follows the
request's timezone. Numeric dates with two possible orders are flagged for
clarification instead of silently choosing US or day-first order. History recall
and upcoming event dates keep separate date-resolution rules. Match-today
lookups use fresh search, and their completed answers are checked before display:
a match finished earlier today cannot also be described as no match today. One
correction may run inside the existing effort budget; unresolved contradictions
leave the sources explicitly unverified.

After each response, a background curator extracts source-backed claims, durable
user facts and topic summaries. It follows the provider selected for that request:
Anthropic uses Haiku; Google AI Studio uses the selected model for both
answers and curation. Invalid output or provider failures preserve the transcript
and retry on a later turn. Migrations run automatically, including the persistent
curation records; no database command is required.

The [component demo](http://localhost:3000/demo) shows search progress, result
counts, source cards, all three verdict badges and as-of dates in either theme.
Its **Stream demo** view replays a comparison, empty results, an interrupted search
or a slow reply you can stop. These are fictional fixtures: no model/search calls
are made, favicons are local, and sample conversations are not saved. The normal
chat at `/` continues to use the configured provider.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
