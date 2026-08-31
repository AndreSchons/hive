import { join } from 'node:path';
import { BrowserWindow, app } from 'electron';
import { ClaudeAdapter, GitWorktreeManager, createAdapterRegistry } from '@hive/agents';
import { AppStore, EventStore, openDatabase, type Db } from '@hive/store';
import { EventBridge } from './event-bridge';
import { DEFAULT_ROSTER, registerIpc, unregisterIpc } from './ipc';
import { RunSupervisor } from './run-supervisor';
import { databasePath } from './paths';
import { createWindow } from './window';

// O nome do pacote e "@hive/shell", e a barra viraria diretorio dentro de
// userData. Fixa aqui, antes de qualquer getPath.
app.setName('hive');

let db: Db | null = null;
let bridge: EventBridge | null = null;
let runs: RunSupervisor | null = null;

function boot(): void {
  const path = databasePath();
  db = openDatabase({ path });

  const events = new EventStore(db);
  const appStore = new AppStore(db);

  const window = createWindow();
  bridge = new EventBridge(events, window);
  // As copias de trabalho ficam fora do repositorio: dentro dele apareceriam
  // como pasta nao rastreada no `git status` de quem esta usando o projeto.
  runs = new RunSupervisor(
    events,
    createAdapterRegistry([new ClaudeAdapter()]),
    DEFAULT_ROSTER,
    new GitWorktreeManager(),
    join(app.getPath('userData'), 'worktrees'),
  );

  registerIpc({
    events,
    app: appStore,
    bridge,
    runs,
    window: () => (window.isDestroyed() ? null : window),
  });

  window.on('closed', () => {
    bridge?.stop();
    bridge = null;
    // Nao deixa subprocesso de agente orfao rodando depois da janela fechar.
    runs?.stop();
    runs = null;
  });
}

// Segunda instancia rouba o foco da primeira em vez de abrir outra janela sobre
// o mesmo banco -- dois processos escrevendo no mesmo SQLite sem necessidade.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [window] = BrowserWindow.getAllWindows();
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });

  app.whenReady().then(boot).catch((error: unknown) => {
    console.error('[main] falha ao iniciar:', error);
    app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) boot();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('will-quit', () => {
    unregisterIpc();
    runs?.stop();
    bridge?.stop();
    db?.close();
    db = null;
  });
}
