import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** Find the monorepo root (the folder containing pnpm-workspace.yaml), starting from cwd. */
export function findRepoRoot(start = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

/** Load the root .env file if present. Variables already in the environment win. */
export function loadRootEnv(): void {
  const file = resolve(findRepoRoot(), '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name} (see .env.example)`);
  return value;
}
