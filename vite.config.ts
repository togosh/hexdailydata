import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

export default defineConfig({
  root: 'src/web',
  plugins: [
    react(),
    {
      name: 'local-openapi-asset',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'openapi.json',
          source: readFileSync('docs/openapi.json'),
        });
      },
    },
  ],
  build: { outDir: '../../dist/web', emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    port: 4321,
    strictPort: true,
    proxy: {
      '/api/v2': 'http://127.0.0.1:4320',
      '/health': 'http://127.0.0.1:4320',
    },
  },
});
