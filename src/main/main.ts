import { app, BrowserWindow } from 'electron';
import path from 'path';
import { setupIpcHandlers } from './ipcHandlers';
import { AudioRecorder } from './audioRecorder';
import { TranscriptionService } from './transcriptionService';
import { SettingsStore, resolvePythonExecutable, settingsFilePath } from './settingsStore';

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 960,
    minHeight: 640,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  if (process.env.NADABODHA_DEV_TOOLS === '1') {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();

  const recorder = new AudioRecorder();
  const settingsStore = new SettingsStore(settingsFilePath(app.getPath('userData')));
  const transcriptionService = new TranscriptionService({
    pythonExecutable: () => resolvePythonExecutable(settingsStore.get()),
    getSttConfig: () => {
      const settings = settingsStore.get();
      return { modelRepo: settings.activeModel, cacheDir: settings.sttCacheDir };
    },
  });

  if (!mainWindow) {
    throw new Error('Main window not created');
  }

  const { dictation } = setupIpcHandlers({
    mainWindow,
    transcriptionService,
    recorder,
    settingsStore,
  });

  // The global Option hook must never outlive the app (approved plan,
  // workstream 3: "Stop the hook on app quit").
  if (dictation) {
    app.on('will-quit', () => {
      dictation.stop();
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
