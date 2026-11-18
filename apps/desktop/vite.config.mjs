import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { cssUrlExpressions } from '../../scripts/lib/css-url-expressions.mjs';
import { customizationPlugin, mergePlans } from '../../scripts/lib/customization-plugin.mjs';
import { bundledPlan } from '../../scripts/bundled-extensions.mjs';

/**
 * The desktop Vite configuration. It adds the only customization plugin, for the bundled first-party plan merged with an
 * optional external plan; scripts/build-local-customization.mjs passes its plan here. A namespace in both fails the build.
 */
export function desktopConfig(mode, external = null) {
  return {
    base: './',
    plugins: [cssUrlExpressions(), customizationPlugin(mergePlans(bundledPlan(), external))],
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
