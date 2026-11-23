import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { tables } from './schema';

// Return DATE columns as plain 'YYYY-MM-DD' strings instead of shifting them through JS Dates.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);
// NUMERIC as JS numbers (answer values are small; precision isn't at risk).
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)));
// COUNT(*) is BIGINT; our counts fit comfortably in a JS number.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => (v === null ? null : Number(v)));

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
export type Db = NodePgDatabase<typeof tables>;

export interface Tx {
  /** Typed query builder bound to this transaction. */
  db: Db;
  /** Raw client for hand-written SQL (analytics) and transactional job enqueueing. */
  client: PoolClient;
}

export function createPool(connectionString: string, max = 10): Pool {
  const pool = new pg.Pool({ connectionString, max, application_name: 'survey-management' });
  // An idle client erroring (e.g. DB restart) must not crash the process.
  pool.on('error', () => {});
  return pool;
}

/**
 * Run `fn` in a transaction scoped to one tenant. Row-level security policies compare every row's
 * org_id to `app.org_id`, so queries can only see and write this org's data. Pass `null` for
 * work that only touches global tables (users, sessions): every tenant table then returns no rows.
 */
export async function withTenant<T>(
  pool: Pool,
  orgId: string | null,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    if (orgId) await client.query(`select set_config('app.org_id', $1, true)`, [orgId]);
    const result = await fn({ db: drizzle({ client, schema: tables }), client });
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** A transaction with no tenant context (global tables only). */
export function withGlobal<T>(pool: Pool, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withTenant(pool, null, fn);
}
