import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import PgBoss from 'pg-boss';
import { createPool } from './client';
import { ALL_QUEUES } from './jobs';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

/**
 * Apply pending SQL migrations (forward-only), install the pg-boss job schema and create every
 * queue, then grant the application role access. Runs as the database owner.
 */
export async function migrate(ownerUrl: string, log: (message: string) => void = () => {}): Promise<void> {
  const pool = createPool(ownerUrl, 2);
  try {
    const client = await pool.connect();
    try {
      await client.query(`select pg_advisory_lock(hashtext('survey-migrations'))`);
      await client.query(
        `create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`,
      );
      const applied = new Set(
        (await client.query<{ name: string }>('select name from schema_migrations')).rows.map((r) => r.name),
      );
      const files = readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith('.sql'))
        .sort();
      for (const file of files) {
        if (applied.has(file)) continue;
        const sql = readFileSync(`${MIGRATIONS_DIR}/${file}`, 'utf8');
        await client.query('begin');
        try {
          await client.query(sql);
          await client.query('insert into schema_migrations (name) values ($1)', [file]);
          await client.query('commit');
          log(`applied ${file}`);
        } catch (error) {
          await client.query('rollback');
          throw new Error(`Migration ${file} failed: ${(error as Error).message}`);
        }
      }
    } finally {
      await client.query(`select pg_advisory_unlock(hashtext('survey-migrations'))`).catch(() => {});
      client.release();
    }

    const boss = new PgBoss({ connectionString: ownerUrl, schedule: false, supervise: false, max: 2 });
    boss.on('error', () => {});
    await boss.start();
    for (const name of ALL_QUEUES) {
      if (!(await boss.getQueue(name))) {
        await boss.createQueue(name, { name, retryLimit: 5, retryDelay: 30, retryBackoff: true });
        log(`created queue ${name}`);
      }
    }
    await boss.stop({ graceful: false, wait: true });

    await pool.query(`
      grant usage on schema pgboss to survey_app;
      grant select, insert, update, delete on all tables in schema pgboss to survey_app;
      grant usage, select on all sequences in schema pgboss to survey_app;
      grant execute on all functions in schema pgboss to survey_app;
      alter default privileges in schema pgboss grant select, insert, update, delete on tables to survey_app;
    `);
  } finally {
    await pool.end();
  }
}
