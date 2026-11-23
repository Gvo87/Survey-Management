import { loadRootEnv, requireEnv } from '../env';
import { migrate } from '../migrate';

loadRootEnv();
const test = process.argv.includes('--test');
const url = requireEnv(test ? 'TEST_DATABASE_OWNER_URL' : 'DATABASE_OWNER_URL');

await migrate(url, (m) => console.log(`[migrate${test ? ':test' : ''}] ${m}`));
console.log(`[migrate${test ? ':test' : ''}] up to date`);
