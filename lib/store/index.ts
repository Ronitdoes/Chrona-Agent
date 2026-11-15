import { drizzle as postgresDrizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { Clock } from "../clock";
import { databaseUrlSchema } from "../database-url";
import { migrate } from "./migrate";
import { createCurationQueries } from "./curation";
import { createQueries } from "./queries";
import * as schema from "./schema";
import { createRecallQueries } from "./recall";

export type StoreOptions = {
  databaseUrl: string;
  clock?: () => Clock;
};

export async function createStore(options: StoreOptions) {
  const databaseUrl = databaseUrlSchema.parse(options.databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  const db = postgresDrizzle(pool, { schema });
  const close = () => pool.end();
  const driver = "postgres" as const;

  try {
    await migrate(db);
    return { db, driver, close, ...createQueries(db, options.clock), ...createCurationQueries(db), ...createRecallQueries(db) };
  } catch {
    await close().catch(() => undefined);
    throw new Error("Postgres initialization failed. Check DATABASE_URL and run npm run db:up for local development.");
  }
}

export type Store = Awaited<ReturnType<typeof createStore>>;

const shared = globalThis as typeof globalThis & { webAgentStore?: Promise<Store> };
let readyStore: Promise<Store> | undefined;

// Keep the connection across reloads, but not stale query closures or schema
// readiness. A new module generation migrates and rebinds the existing handle
// once; concurrent requests share that readiness promise and the existing pool.
export function getStore(): Promise<Store> {
  if (readyStore) return readyStore;
  const reused = Boolean(shared.webAgentStore);
  const connection = shared.webAgentStore ??= import("../env")
    .then(({ env }) => createStore({ databaseUrl: env.DATABASE_URL }));
  void connection.catch(() => {
    if (shared.webAgentStore === connection) shared.webAgentStore = undefined;
  });
  const pending = connection.then(async store => {
    if (!reused) return store; // createStore already migrated this connection.
    await migrate(store.db);
    return { ...store, ...createQueries(store.db), ...createCurationQueries(store.db), ...createRecallQueries(store.db) };
  });
  readyStore = pending;
  void pending.catch(() => {
    // A failed refresh may be retried without discarding a healthy connection.
    if (readyStore === pending) readyStore = undefined;
  });
  return pending;
}
