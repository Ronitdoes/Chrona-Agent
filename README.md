This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

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

For Groq, use:

```dotenv
MODEL_PROVIDER=groq
GROQ_API_KEY=your-key-here
GROQ_MODEL=qwen/qwen3.8-27b
TAVILY_API_KEY=your-search-key-here
```

For Anthropic, keep `MODEL_PROVIDER=anthropic` and set `ANTHROPIC_API_KEY` instead
of the Groq key. Both providers expose exactly one tool, `web_search`. Never commit
your `.env` or `.env.local` file. Restart the dev server after changing provider settings.

The chat endpoint accepts `{ "message": "Hello", "tz": "Asia/Kolkata" }` and an
optional UUID `sessionId`. It returns SSE and sets HttpOnly anonymous identity and
conversation cookies. `X-Session-Id` identifies the conversation; `X-Turn-Id` and
the SSE `done.turnId` identify the request for tracing. History returns sessions
with turns grouped into local calendar days. It accepts `tz`, `sessionId`, `limit`
(1–200) and an opaque `before` cursor; `nextCursor` retrieves the next older page.
Anonymous cookies provide continuity, not account authentication.

Groq chat requests have a combined input cap (`GROQ_MAX_INPUT_TOKENS`, default
6500) covering the system prompt, history, tool schema and search results. It
conservatively counts serialized UTF-8 bytes as tokens, reduces excerpts and omits
older context when needed, and preserves the current question and clock. The
output cap is separate (`GROQ_MAX_OUTPUT_TOKENS`, default 768). Adjust these to
your account's quotas; a model's context window can exceed its account rate limit.

If Groq fails after a successful search, the agent can make one short final-answer
attempt from the existing results within the same time and step budgets. It does
not repeat searches. Rate-limit recovery honors a numeric Retry-After; otherwise
the response explains the provider failure and preserves available sources. An
HTTP 413 recovery reduces the input budget before trying again.
Explicit live-score requests and requests to search the web require `web_search`
on the first model step; the provider cannot silently skip that lookup.

After each response, a background curator extracts source-backed claims, durable
user facts and topic summaries. It follows `MODEL_PROVIDER`: Anthropic uses Haiku;
Groq uses `GROQ_MODEL` and `GROQ_API_KEY` for both answers and curation, with no
Anthropic key required. Invalid output or provider failures preserve the transcript
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
