import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  envDir: '../..',
  server: {
    port: 5174,
    strictPort: true,
    proxy: { '/r': 'http://localhost:3000' },
  },
  preview: {
    port: 5174,
    proxy: { '/r': 'http://localhost:3000' },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
