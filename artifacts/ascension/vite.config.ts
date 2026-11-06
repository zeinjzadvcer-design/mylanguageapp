import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

const port = Number(process.env.PORT ?? 5173);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${process.env.PORT}"`);
}

// Path the app is served under. '/' for a normal deployment; override when
// mounting the app beneath a sub-path on a shared host.
const basePath = process.env.BASE_PATH ?? '/';

// The app calls the API with relative /api paths so both can share one origin
// in production. In development the API runs as a separate process, so proxy
// /api through to it.
const apiProxyTarget = process.env.API_PROXY_TARGET ?? 'http://localhost:8080';

// The same security headers vercel.json sends in production, so a page that
// only works when framed, or a feature that needs a blocked permission, breaks
// here first rather than after deploying.
const securityHeaders = {
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=(self)',
};

export default defineConfig({
  base: basePath,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      '@assets': path.resolve(
        import.meta.dirname,
        '..',
        '..',
        'attached_assets',
      ),
    },
    dedupe: ['react', 'react-dom'],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts: true,
    headers: securityHeaders,
    proxy: {
      '/api': {
        target: apiProxyTarget,
        changeOrigin: false,
      },
    },
    // Filesystem events do not cross a Docker bind mount on Windows or macOS,
    // so the dev server never sees host edits and hot reload silently stops
    // working. Polling is the only reliable watcher there; it costs CPU, so it
    // stays opt-in and off for native runs.
    watch:
      process.env.VITE_USE_POLLING === '1'
        ? { usePolling: true, interval: 300 }
        : undefined,
    fs: {
      strict: true,
    },
  },
  preview: {
    port,
    host: '0.0.0.0',
    allowedHosts: true,
    headers: securityHeaders,
    proxy: {
      '/api': {
        target: apiProxyTarget,
        changeOrigin: false,
      },
    },
  },
});
