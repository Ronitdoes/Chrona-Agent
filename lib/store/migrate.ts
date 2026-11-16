import { sql } from "drizzle-orm";
import type { StoreDatabase } from "./queries";

// Hand-written SQL is authoritative, including the generated column and GIN index.
// Keep migrations append-only. Embedding the SQL avoids runtime file tracing issues.
const migrations = [{
  version: 1,
  statements: [
    `CREATE TABLE turns (
      id bigserial PRIMARY KEY,
      user_id text NOT NULL,
      session_id text NOT NULL,
      role text NOT NULL CHECK (role IN ('user', 'assistant')),
      content text NOT NULL,
      ts timestamptz NOT NULL DEFAULT now(),
      tz text,
      tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
    )`,
    `CREATE INDEX turns_user_ts ON turns (user_id, ts)`,
    `CREATE INDEX turns_tsv ON turns USING gin (tsv)`,
    `CREATE TABLE claims (
      id bigserial PRIMARY KEY,
      turn_id bigint REFERENCES turns(id),
      user_id text NOT NULL,
      subject text NOT NULL,
      attribute text NOT NULL,
      value text NOT NULL,
      as_of timestamptz NOT NULL,
      source_urls jsonb NOT NULL DEFAULT '[]',
      volatility text NOT NULL DEFAULT 'medium' CHECK (volatility IN ('low', 'medium', 'high')),
      superseded_by bigint REFERENCES claims(id)
    )`,
    `CREATE INDEX claims_user_subject ON claims (user_id, subject)`,
    `CREATE INDEX claims_user_turn ON claims (user_id, turn_id)`,
    `CREATE TABLE memory (
      user_id text NOT NULL,
      key text NOT NULL,
      value text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      source_turn_id bigint,
      PRIMARY KEY (user_id, key)
    )`,
    `CREATE TABLE threads (
      id bigserial PRIMARY KEY,
      user_id text NOT NULL,
      title text NOT NULL,
      summary text NOT NULL,
      last_ts timestamptz NOT NULL
    )`,
    `CREATE INDEX threads_user_last_ts ON threads (user_id, last_ts)`,
  ],
}, {
  version: 2,
  statements: [
    `ALTER TABLE threads ADD COLUMN source_turn_id bigint REFERENCES turns(id)`,
    `CREATE TABLE curations (
      turn_id bigint PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE,
      user_turn_id bigint NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
      user_id text NOT NULL,
      evidence jsonb NOT NULL,
      completed timestamptz
    )`,
    `CREATE INDEX curations_pending ON curations (user_id, turn_id) WHERE completed IS NULL`,
  ],
}, {
  version: 3,
  statements: [
    `CREATE TABLE recall_references (
      answer_turn_id bigint PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE,
      request_turn_id bigint NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
      user_id text NOT NULL,
      source_turn_ids jsonb NOT NULL
    )`,
    `CREATE INDEX recall_references_user_answer ON recall_references (user_id, answer_turn_id)`,
  ],
}, {
  version: 4,
  statements: [
    `ALTER TABLE recall_references ADD COLUMN history_only boolean NOT NULL DEFAULT true`,
  ],
}, {
  version: 5,
  statements: [`ALTER TABLE recall_references ADD COLUMN collection jsonb`],
}, {
  version: 6,
  statements: [
    `CREATE TABLE "user" (id text PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE, email_verified boolean NOT NULL DEFAULT false, image text, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL)`,
    `CREATE TABLE "session" (id text PRIMARY KEY, expires_at timestamptz NOT NULL, token text NOT NULL UNIQUE, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, ip_address text, user_agent text, user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE)`,
    `CREATE INDEX auth_session_user ON "session"(user_id)`,
    `CREATE TABLE account (id text PRIMARY KEY, account_id text NOT NULL, provider_id text NOT NULL, user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE, access_token text, refresh_token text, id_token text, access_token_expires_at timestamptz, refresh_token_expires_at timestamptz, scope text, password text, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL)`,
    `CREATE INDEX auth_account_user ON account(user_id)`,
    `CREATE TABLE verification (id text PRIMARY KEY, identifier text NOT NULL, value text NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL)`,
    `CREATE TABLE provider_credentials (user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE, provider text NOT NULL CHECK (provider IN ('anthropic','gemini','tavily','exa')), encrypted text NOT NULL, PRIMARY KEY(user_id, provider))`,
    `CREATE TABLE conversations (id text PRIMARY KEY, user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE)`,
    `CREATE INDEX conversations_user ON conversations(user_id)`,
  ],
}, {
  version: 7,
  statements: [`ALTER TABLE turns ADD COLUMN answer_ui jsonb`],
}];

export async function migrate(db: StoreDatabase): Promise<void> {
  await db.transaction(async (tx) => {
    // Serializes first boot across Postgres instances; released on commit/rollback.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(781423, 1)`);
    await tx.execute(sql`CREATE TABLE IF NOT EXISTS web_agent_migrations (
      version integer PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = await tx.execute<{ version: number }>(sql`SELECT version FROM web_agent_migrations`);
    const versions = new Set(applied.rows.map((row) => row.version));

    for (const migration of migrations) {
      if (versions.has(migration.version)) continue;
      for (const statement of migration.statements) {
        await tx.execute(sql.raw(statement));
      }
      await tx.execute(sql`INSERT INTO web_agent_migrations (version) VALUES (${migration.version})`);
    }
  });
}
