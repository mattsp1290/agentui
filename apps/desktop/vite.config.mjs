import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { cssUrlExpressions } from '../../scripts/lib/css-url-expressions.mjs';
import { customizationPlugin } from '../../scripts/lib/customization-plugin.mjs';

/**
 * The desktop Vite configuration. With no plan (the product build) it adds no customization plugin and the selection
 * module stays the committed empty array. scripts/build-local-customization.mjs passes the plan it builds and qualifies.
 */
export function desktopConfig(mode, plan = null) {
  return {
    base: './',
    plugins: [cssUrlExpressions(), ...(plan ? [customizationPlugin(plan)] : [])],
    build: mode === 'browser' ? { outDir: 'web-dist-browser', target: 'safari14', rollupOptions: {
      input: ['index.html', 'browser.html'].map(entry => fileURLToPath(new URL(entry, import.meta.url))),
    } } : { outDir: 'web-dist', target: 'safari14', rollupOptions: {
      input: ['index.html', 'provider-setup.html'].map(entry => fileURLToPath(new URL(entry, import.meta.url))),
    } },
    server: {
      host: '127.0.0.1',
      port: 1420,
      strictPort: true,
      watch: { ignored: ['**/src-tauri/**'] },
    },
  };
}

export default defineConfig(({ mode }) => desktopConfig(mode));
