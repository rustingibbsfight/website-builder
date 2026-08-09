import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/editor/',
  plugins: [react()],
  build: { outDir: 'dist', sourcemap: false },
  server: {
    port: 5175,
    proxy: {
      // `auth` and `blocks` were missing: the editor calls both on load, so in
      // `vite dev` they fell through to Vite and 404ed. Not a production bug —
      // there the SPA is served by wb-api — which is exactly why it survived.
      '^/(sites|components|templates|blocks|auth|preview|health|openapi).*': 'http://127.0.0.1:4000',
    },
  },
});
