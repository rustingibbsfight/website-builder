import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/editor/',
  plugins: [react()],
  build: { outDir: 'dist', sourcemap: false },
  server: {
    port: 5175,
    proxy: {
      '^/(sites|components|templates|preview|health|openapi).*': 'http://127.0.0.1:4000',
    },
  },
});
