import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig(({ mode }) => ({
  base: './',
  build: mode === 'browser' ? { outDir: 'web-dist-browser', target: 'safari14', rollupOptions: {
    input: fileURLToPath(new URL('./browser.html', import.meta.url)),
  } } : { outDir: 'web-dist', target: 'safari14' },
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
}));
