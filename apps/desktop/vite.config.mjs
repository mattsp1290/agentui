import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { cssUrlExpressions } from '../../scripts/lib/css-url-expressions.mjs';
import { customizationPlugin } from '../../scripts/lib/customization-plugin.mjs';
import { bundledPlan } from '../../scripts/bundled-extensions.mjs';

/**
 * The desktop Vite configuration. It adds the only customization plugin, for `plan`: the bundled first-party plan by
 * default. scripts/build-local-customization.mjs passes the bundled plan already merged with its external plan, so the
 * plan it builds is the one it qualifies.
 */
export function desktopConfig(mode, plan = bundledPlan()) {
  return {
    base: './',
    plugins: [cssUrlExpressions(), customizationPlugin(plan)],
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
