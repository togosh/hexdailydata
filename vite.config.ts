import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/web',
  plugins: [react()],
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
