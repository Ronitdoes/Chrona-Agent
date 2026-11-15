import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as postgresDrizzle } from "drizzle-orm/node-postgres";
import { drizzle as pgliteDrizzle } from "drizzle-orm/pglite";
import { Pool } from "pg";
import type { Clock } from "../clock";
import { migrate } from "./migrate";
import { createCurationQueries } from "./curation";
import { createQueries, type StoreDatabase } from "./queries";
import * as schema from "./schema";

export type StoreOptions = {
  databaseUrl?: string;
  dataDir?: string;
  clock?: () => Clock;
};

export async function createStore(options: StoreOptions = {}) {
  const databaseUrl = options.databaseUrl?.trim();
  let db: StoreDatabase;
  let close: () => Promise<void>;
  const driver = databaseUrl ? "postgres" : "pglite";

  if (databaseUrl) {
    const pool = new Pool({ connectionString: databaseUrl });
    db = postgresDrizzle(pool, { schema });
    close = () => pool.end();
  } else {
    const dataDir = options.dataDir ?? resolve("data/pglite");
    if (dataDir !== ":memory:") await mkdir(dataDir, { recursive: true });
    const client = new PGlite(dataDir === ":memory:" ? undefined : dataDir);
    db = pgliteDrizzle(client, { schema });
    close = () => client.close();
  }

  try {
    await migrate(db);
    return { db, driver, close, ...createQueries(db, options.clock), ...createCurationQueries(db) };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}

export type Store = Awaited<ReturnType<typeof createStore>>;

const shared = globalThis as typeof globalThis & { webAgentStore?: Promise<Store> };

// Share initialization and the client across requests and Next.js development reloads.
export function getStore(): Promise<Store> {
  shared.webAgentStore ??= import("../env")
    .then(({ env }) => createStore({ databaseUrl: env.DATABASE_URL }))
    .catch((error: unknown) => {
      shared.webAgentStore = undefined;
      throw error;
    });
  return shared.webAgentStore;
}
