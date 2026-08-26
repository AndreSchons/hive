import { BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
import { rendererDistPath } from './paths';

/** Servidor do Vite quando rodando em desenvolvimento. */
const devServerUrl = process.env['OFFICE_DEV_SERVER_URL'];

export function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#0b0f17',
    show: false,
    title: 'Agent Office',
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'preload.js'),
      // O renderer roda uma cena 3D e nada mais: sem Node, sem acesso direto ao
      // disco. Tudo passa pelos dois canais declarados no protocol.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.once('ready-to-show', () => window.show());

  // Link externo abre no navegador, nunca dentro da janela do app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (devServerUrl !== undefined && devServerUrl.length > 0) {
    void window.loadURL(devServerUrl);
    window.webContents.openDevTools({ mode: 'detach' });
  } else {
    void window.loadFile(rendererDistPath());
  }

  return window;
}
