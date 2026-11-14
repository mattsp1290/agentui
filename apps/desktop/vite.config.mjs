import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: { outDir: 'web-dist', target: 'safari14' },
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
});
