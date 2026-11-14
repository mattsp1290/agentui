import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  base: './',
  build: { outDir: 'web-dist', target: 'safari14', rollupOptions: { input: {
    desktop: fileURLToPath(new URL('./index.html', import.meta.url)),
    browser: fileURLToPath(new URL('./browser.html', import.meta.url)),
  } } },
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
});
