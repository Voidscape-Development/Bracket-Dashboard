import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In dev the API and socket live on the backend process; in production the
// backend serves these built assets itself, so the same relative paths work.
const target = process.env.BRACKET_API ?? 'http://127.0.0.1:4747';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target, changeOrigin: true },
      '/ws': { target, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    chunkSizeWarningLimit: 900,
  },
});
