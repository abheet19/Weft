// Vite configuration for the @weft/client shell (dev-only tooling; nothing here ships at runtime).
// Binds 127.0.0.1:5173 with a strict port so `npm run dev` fails loudly instead of drifting to
// 5174 while the printed URL says otherwise. The SPA fallback serves `/d/<docId>` from index.html.
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  appType: 'spa',
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1' },
});
