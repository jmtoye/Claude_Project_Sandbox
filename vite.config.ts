import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  root: 'src/client',
  plugins: [preact()],
  build: { outDir: '../../dist/client', emptyOutDir: true, sourcemap: false },
  server: { proxy: { '/api': 'http://127.0.0.1:8787', '/mcp': 'http://127.0.0.1:8787', '/__dev': 'http://127.0.0.1:8787' } },
});
