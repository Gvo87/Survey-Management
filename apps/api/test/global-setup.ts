import { createPool, loadRootEnv, migrate, requireEnv } from '@survey/db';

/** Recreate the test database schema once per test run. */
export default async function setup(): Promise<void> {
  loadRootEnv();
  const ownerUrl = requireEnv('TEST_DATABASE_OWNER_URL');
  const pool = createPool(ownerUrl, 1);
  await pool.query(`
    drop schema if exists pgboss cascade;
    drop schema if exists public cascade;
    create schema public;
    grant all on schema public to public;
  `);
  await pool.end();
  await migrate(ownerUrl);
}
