import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { databaseUrlSchema } from "../lib/database-url";
import { createStore, type Store, type StoreOptions } from "../lib/store";

const localTestUrl = "postgresql://chrona_test:chrona_test_local@127.0.0.1:5433/chrona_test";

export function testDatabaseUrl(value = process.env.TEST_DATABASE_URL ?? localTestUrl): string {
  const result = databaseUrlSchema.safeParse(value);
  if (!result.success) throw new Error("TEST_DATABASE_URL must be a valid PostgreSQL URL");
  const url = new URL(result.data);
  if (url.hostname !== "127.0.0.1" || url.port !== "5433" || url.pathname !== "/chrona_test" || url.username !== "chrona_test" || url.search || url.hash) {
    throw new Error("TEST_DATABASE_URL must point to the isolated Docker test service at 127.0.0.1:5433/chrona_test as chrona_test");
  }
  return result.data;
}

export async function createTestDatabase() {
  const adminUrl = testDatabaseUrl();
  const admin = new Pool({ connectionString: adminUrl, connectionTimeoutMillis: 3_000, max: 1 });
  const name = `chrona_test_${randomUUID().replaceAll("-", "")}`;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } catch {
    await admin.end();
    throw new Error("Test Postgres unavailable. Run npm run db:test:up before npm test.");
  }
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const stores = new Set<Store>();
  let closed = false;
  return {
    databaseUrl: url.toString(),
    async open(options: Omit<StoreOptions, "databaseUrl"> = {}): Promise<Store> {
      if (closed) throw new Error("Test database has been closed");
      const store = await createStore({ ...options, databaseUrl: url.toString() });
      const close = store.close;
      let ended = false;
      store.close = async () => {
        if (ended) return;
        ended = true;
        await close();
        stores.delete(store);
      };
      stores.add(store);
      return store;
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        await Promise.all([...stores].map(store => store.close()));
        await admin.query(`DROP DATABASE "${name}"`);
      } finally { await admin.end(); }
    },
  };
}

export async function createTestStore(options: Omit<StoreOptions, "databaseUrl"> = {}): Promise<Store> {
  const database = await createTestDatabase();
  try {
    const store = await database.open(options);
    return { ...store, close: () => database.close() };
  } catch (error) {
    await database.close();
    throw error;
  }
}
