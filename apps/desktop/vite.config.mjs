import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { cssUrlExpressions } from '../../scripts/lib/css-url-expressions.mjs';

export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [cssUrlExpressions()],
  build: mode === 'browser' ? { outDir: 'web-dist-browser', target: 'safari14', rollupOptions: {
    input: ['index.html', 'browser.html'].map(entry => fileURLToPath(new URL(entry, import.meta.url))),
  } } : { outDir: 'web-dist', target: 'safari14' },
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
}));
