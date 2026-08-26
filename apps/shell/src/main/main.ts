import { BrowserWindow, app } from 'electron';
import { AppStore, EventStore, openDatabase, type Db } from '@office/store';
import { EventBridge } from './event-bridge';
import { registerIpc, unregisterIpc } from './ipc';
import { databasePath } from './paths';
import { createWindow } from './window';

let db: Db | null = null;
let bridge: EventBridge | null = null;

function boot(): void {
  const path = databasePath();
  db = openDatabase({ path });

  const events = new EventStore(db);
  const appStore = new AppStore(db);

  const window = createWindow();
  bridge = new EventBridge(events, window);

  registerIpc({
    events,
    app: appStore,
    bridge,
    window: () => (window.isDestroyed() ? null : window),
  });

  window.on('closed', () => {
    bridge?.stop();
    bridge = null;
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
    bridge?.stop();
    db?.close();
    db = null;
  });
}
