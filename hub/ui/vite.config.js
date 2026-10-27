import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The hub serves this build from hub/ui/dist at "/" when hub.conf has
// serve_ui: true (hub/src/app.js finalizeApp). In development the API is
// proxied to a running hub.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      '/v1': { target: process.env.WHM_HUB_URL || 'http://127.0.0.1:7443', changeOrigin: false, secure: false },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.{js,jsx}'],
  },
});
