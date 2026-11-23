// Development only: drop everything and re-run migrations.
import { createPool } from '../client';
import { loadRootEnv, requireEnv } from '../env';
import { migrate } from '../migrate';

loadRootEnv();
if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to reset a production database.');
  process.exit(1);
}
const test = process.argv.includes('--test');
const url = requireEnv(test ? 'TEST_DATABASE_OWNER_URL' : 'DATABASE_OWNER_URL');

const pool = createPool(url, 1);
await pool.query(`
  drop schema if exists pgboss cascade;
  drop schema public cascade;
  create schema public;
  grant all on schema public to public;
`);
await pool.end();
console.log('[reset] dropped all tables');
await migrate(url, (m) => console.log(`[migrate] ${m}`));
console.log('[reset] done');
