import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { cssUrlExpressions } from '../../scripts/lib/css-url-expressions.mjs';
import { customizationPlugin, mergePlans } from '../../scripts/lib/customization-plugin.mjs';
import { bundledPlan } from '../../scripts/bundled-extensions.mjs';

/** scripts/build-local-customization.mjs names its external plan here so exactly one customization plugin runs. */
export const EXTERNAL_PLAN_VARIABLE = 'AGENTUI_EXTERNAL_DESKTOP_PLAN';

export default defineConfig(({ mode }) => {
  const external = process.env[EXTERNAL_PLAN_VARIABLE] ? JSON.parse(readFileSync(process.env[EXTERNAL_PLAN_VARIABLE], 'utf8')) : null;
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
});
