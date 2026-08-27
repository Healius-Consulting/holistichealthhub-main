import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { resolvePortalBuildId } from './platform/portal-build-id.mjs';

const pharmacyModules = /^\.\/pages\/(Dashboard|PharmacyOverview|CreateOrder|Orders|FormularyPricing|Patients|PharmacySettings|PharmacyFinance)$/;

export default defineConfig({
  root: resolve(__dirname, 'apps/admin'),
  publicDir: resolve(__dirname, 'public'),
  envDir: __dirname,
  plugins: [react()],
  resolve: { alias: [{ find: pharmacyModules, replacement: resolve(__dirname, 'src/surfaces/UnavailableSurface.tsx') }] },
  define: {
    // Stamped so Display settings can name the running build to support.
    'import.meta.env.VITE_PORTAL_BUILD_ID': JSON.stringify(resolvePortalBuildId()),
    'import.meta.env.VITE_APP_SURFACE': JSON.stringify('admin'),
    'import.meta.env.VITE_AUTH_MODE': JSON.stringify('cookie'),
    'import.meta.env.VITE_APP_PATH_PREFIX': JSON.stringify('/admin'),
    'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/admin'),
  },
  server: {
    port: 5175,
    proxy: {
      '/admin/v1': { target: 'http://127.0.0.1:8080', rewrite: path => path.replace(/^\/admin/, '') },
      '/admin/v2': { target: 'http://127.0.0.1:8080', rewrite: path => path.replace(/^\/admin/, '') },
      '/health': 'http://127.0.0.1:8080',
    },
  },
  build: { outDir: resolve(__dirname, 'dist-admin'), emptyOutDir: true, sourcemap: false },
});
