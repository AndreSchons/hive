import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

// Os pacotes do workspace sao CJS em dist: o interop do vite nao enxerga os
// nomes re-exportados. Resolver os fontes (TS) desvia do problema e custa o
// mesmo tanto de build -- os tipos continuam vindo dos .d.ts via tsconfig.
const protocolSrc = fileURLToPath(new URL('../../packages/protocol/src/index.ts', import.meta.url));
const simulatorSrc = fileURLToPath(new URL('../../tools/simulator/src/index.ts', import.meta.url));

export default defineConfig({
  plugins: [react(), tailwind()],
  resolve: {
    alias: {
      '@office/protocol': protocolSrc,
      '@office/simulator': simulatorSrc,
    },
  },
  // Caminhos relativos: em producao o Electron carrega o index.html por file://,
  // e caminho absoluto quebraria a resolucao dos assets.
  base: './',
  server: { port: 5173, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: true },
});
