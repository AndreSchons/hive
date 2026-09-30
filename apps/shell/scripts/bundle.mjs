#!/usr/bin/env node
// Monta `app/`, a pasta que o electron-builder empacota. O main vira um arquivo
// so (o workspace inteiro vai inline), porque os pacotes @hive/* sao links do
// pnpm que nao existem na maquina de quem instala. O layout espelha o do repo
// -- app/shell/dist/main, app/hub/dist -- para `paths.ts` e `window.ts`
// acharem renderer e preload sem saber se estao empacotados.
import { cpSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const shell = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(shell, 'app');
const own = JSON.parse(readFileSync(join(shell, 'package.json'), 'utf8'));

rmSync(out, { recursive: true, force: true });

await build({
  entryPoints: [join(shell, 'src', 'main', 'main.ts')],
  outfile: join(out, 'shell', 'dist', 'main', 'main.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  // Nativo nao entra no bundle: vai inteiro em node_modules, logo abaixo.
  external: ['electron', 'better-sqlite3'],
});

// O preload so importa tipos, entao o `tsc` ja o deixa pronto.
cpSync(join(shell, 'dist', 'preload'), join(out, 'shell', 'dist', 'preload'), { recursive: true });
cpSync(join(shell, '..', 'hub', 'dist'), join(out, 'hub', 'dist'), { recursive: true });

// better-sqlite3 traz o binario pronto (N-API) e nenhuma dependencia de
// execucao: copiar a pasta basta, sem recompilar para o Electron.
const store = createRequire(join(shell, '..', '..', 'packages', 'store', 'package.json'));
const sqlite = dirname(realpathSync(store.resolve('better-sqlite3/package.json')));
const sqliteManifest = JSON.parse(readFileSync(join(sqlite, 'package.json'), 'utf8'));
for (const part of ['lib', 'prebuilds']) {
  cpSync(join(sqlite, part), join(out, 'node_modules', 'better-sqlite3', part), { recursive: true });
}
// `node-addon-api` so serve para compilar; com o binario pronto, sai do manifesto
// para o electron-builder nao cobrar uma dependencia que nunca e carregada.
delete sqliteManifest.dependencies;
writeFileSync(join(out, 'node_modules', 'better-sqlite3', 'package.json'), JSON.stringify(sqliteManifest, null, 2));
const sqliteVersion = sqliteManifest.version;

mkdirSync(out, { recursive: true });
writeFileSync(
  join(out, 'package.json'),
  JSON.stringify(
    {
      name: 'hive',
      productName: own.productName,
      version: own.version,
      description: 'Escritorio de agentes de IA que trabalham no seu projeto.',
      author: { name: 'Andre Schons', email: 'andreferens86@gmail.com' },
      homepage: 'https://github.com/AndreSchons/hive',
      // No Linux, e isso que liga a janela aberta ao atalho do menu (WM_CLASS).
      desktopName: 'hive.desktop',
      main: 'shell/dist/main/main.js',
      dependencies: { 'better-sqlite3': sqliteVersion },
    },
    null,
    2,
  ),
);

console.log(`[bundle] pronto em ${out}`);
