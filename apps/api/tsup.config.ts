import { defineConfig } from 'tsup';

// Production build: bundle the API and worker (including workspace packages) into dist/.
// Third-party dependencies stay external and are installed with `pnpm install --prod`.
export default defineConfig({
  entry: ['src/main.ts', 'src/worker.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  clean: true,
  noExternal: [/^@survey\//],
});
