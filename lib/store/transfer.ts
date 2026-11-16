import { sql } from "drizzle-orm";
import { z } from "zod";
import type { StoreDatabase } from "./queries";

const tables = ["turns", "claims", "memory", "threads", "curations", "recall_references"] as const;
const sequenceTables = ["turns", "claims", "threads"] as const;
const positiveInteger = z.string().regex(/^[1-9]\d*$/);
const sequenceState = z.object({ lastValue: positiveInteger, isCalled: z.boolean() }).strict();
const snapshotSchema = z.object({
  format: z.literal(1),
  versions: z.array(z.number().int().min(1).max(6)).min(1).refine(versions => versions.every((version, i) => version === i + 1)),
  tables: z.partialRecord(z.enum(tables), z.object({
    columns: z.array(z.object({ name: z.string(), type: z.string() }).strict()).min(1),
    rows: z.array(z.array(z.string().nullable())),
  }).strict()),
  sequences: z.object({ turns: sequenceState, claims: sequenceState, threads: sequenceState }).strict(),
}).strict();

// Values are PostgreSQL text representations, including bigint and microsecond
// timestamps. Never round-trip them through JavaScript numbers or Date objects.
export type DatabaseSnapshot = z.infer<typeof snapshotSchema>;
const identifier = (value: string) => sql.raw(`"${value.replaceAll('"', '""')}"`);
const sortedRows = (rows: (string | null)[][]) => rows.map(row => JSON.stringify(row)).sort();

export async function importSnapshot(db: StoreDatabase, input: unknown): Promise<Record<string, number>> {
  const snapshot = snapshotSchema.parse(input);
  const version = snapshot.versions.at(-1)!;
  for (const table of tables) {
    if ((table === "curations" && version < 2) || (table === "recall_references" && version < 3)) continue;
    if (!snapshot.tables[table]) throw new Error(`Snapshot is missing table ${table}`);
  }
  return db.transaction(async tx => {
    await tx.execute(sql`LOCK TABLE ${sql.join(tables.map(identifier), sql`, `)} IN ACCESS EXCLUSIVE MODE`);
    for (const table of tables) {
      const count = await tx.execute<{ count: string }>(sql`SELECT count(*)::text AS count FROM ${identifier(table)}`);
      if (count.rows[0].count !== "0") throw new Error("Import requires an empty application database; existing data was not changed");
    }
    const counts: Record<string, number> = {};
    for (const table of tables) {
      const source = snapshot.tables[table];
      if (!source) { counts[table] = 0; continue; }
      const target = await tx.execute<{ name: string; type: string }>(sql`
        SELECT column_name AS name, udt_name AS type FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ${table} AND is_generated = 'NEVER'
        ORDER BY ordinal_position
      `);
      const expected = target.rows.filter(column => !(version < 2 && table === "threads" && column.name === "source_turn_id")
        && !(version < 4 && table === "recall_references" && column.name === "history_only")
        && !(version < 5 && table === "recall_references" && column.name === "collection"));
      if (JSON.stringify(source.columns) !== JSON.stringify(expected)) throw new Error(`Snapshot columns do not match ${table} at version ${version}`);
      for (const row of source.rows) {
        if (row.length !== source.columns.length) throw new Error(`Invalid snapshot row in ${table}`);
        const values = row.map((value, i) => {
          const column = source.columns[i];
          return sql`${table === "claims" && column.name === "superseded_by" ? null : value}::${identifier(column.type)}`;
        });
        await tx.execute(sql`INSERT INTO ${identifier(table)} (${sql.join(source.columns.map(column => identifier(column.name)), sql`, `)}) VALUES (${sql.join(values, sql`, `)})`);
      }
      counts[table] = source.rows.length;
    }
    const claimSource = snapshot.tables.claims!;
    const linkIndex = claimSource.columns.findIndex(column => column.name === "superseded_by");
    const idIndex = claimSource.columns.findIndex(column => column.name === "id");
    for (const row of claimSource.rows) {
      if (row[linkIndex] !== null) await tx.execute(sql`UPDATE claims SET superseded_by = ${row[linkIndex]}::bigint WHERE id = ${row[idIndex]}::bigint`);
    }
    // Compare every transferred field inside the transaction before committing.
    for (const table of tables) {
      const source = snapshot.tables[table];
      if (!source) continue;
      const selection = sql.join(source.columns.map(column => sql`${identifier(column.name)}::text AS ${identifier(column.name)}`), sql`, `);
      const actual = await tx.execute<Record<string, string | null>>(sql`SELECT ${selection} FROM ${identifier(table)}`);
      const rows = actual.rows.map(row => source.columns.map(column => row[column.name]));
      if (JSON.stringify(sortedRows(rows)) !== JSON.stringify(sortedRows(source.rows))) throw new Error(`Transfer verification failed for ${table}`);
    }
    const invalidSearch = await tx.execute<{ count: string }>(sql`SELECT count(*)::text AS count FROM turns WHERE tsv IS DISTINCT FROM to_tsvector('english', content)`);
    if (invalidSearch.rows[0].count !== "0") throw new Error("Transferred full-text search values failed verification");
    for (const table of sequenceTables) {
      const max = await tx.execute<{ id: string }>(sql`SELECT coalesce(max(id), 0)::text AS id FROM ${identifier(table)}`);
      const state = snapshot.sequences[table];
      const sourceNext = BigInt(state.lastValue) + (state.isCalled ? BigInt(1) : BigInt(0));
      const rowNext = BigInt(max.rows[0].id) + BigInt(1);
      const next = sourceNext > rowNext ? sourceNext : rowNext;
      // ALTER SEQUENCE RESTART rolls back with the import, unlike setval().
      await tx.execute(sql`ALTER SEQUENCE ${identifier(`${table}_id_seq`)} RESTART WITH ${sql.raw(next.toString())}`);
    }
    return counts;
  });
}
