import { app, BrowserWindow, globalShortcut } from 'electron';
import fs from 'fs';
import path from 'path';
import { setupIpcHandlers } from './ipcHandlers';
import { AudioRecorder } from './audioRecorder';
import { TranscriptionService } from './transcriptionService';
import { SettingsStore, resolvePythonExecutable, settingsFilePath } from './settingsStore';
import { NoteStore } from './noteStore';

// Suppress benign EPIPE errors from child process stream closures so they don't trigger
// unhandled exception dialogs.
process.on('uncaughtException', (err: Error) => {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED') {
    return;
  }
  console.error('[Uncaught Exception]', err);
});

let mainWindow: BrowserWindow | null = null;

function resolveAppIcon(): string | undefined {
  const candidates = [
    path.join(__dirname, '../assets/icon.png'),
    path.join(__dirname, '../../assets/icon.png'),
    path.join(app.getAppPath(), 'assets/icon.png'),
    path.join(app.getAppPath(), 'dist/assets/icon.png'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function resolveDockIcon(): string | undefined {
  const candidates = [
    path.join(__dirname, '../assets/icon.icns'),
    path.join(__dirname, '../../assets/icon.icns'),
    path.join(app.getAppPath(), 'assets/icon.icns'),
    path.join(app.getAppPath(), 'dist/assets/icon.icns'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return resolveAppIcon();
}

function createWindow(): void {
  const iconPath = resolveAppIcon();

  mainWindow = new BrowserWindow({
    // Plan-fixed default window (v3 plan / test plan §3): 1180x760.
    width: 1180,
    height: 760,
    minWidth: 960,
    minHeight: 640,
    ...(iconPath ? { icon: iconPath } : {}),
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
  // Set native macOS dock icon if running on macOS
  if (process.platform === 'darwin' && app.dock) {
    const dockIcon = resolveDockIcon();
    if (dockIcon) {
      try {
        app.dock.setIcon(dockIcon);
      } catch (err) {
        console.warn('[Dock] Failed to set dock icon:', err);
      }
    }
  }

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

  // Note store: initialize with the configured data directory.
  // On first run (or when no dataDir is set) we use userData/notes as a safe
  // default so the app is always usable without additional setup.
  const resolveDataDir = (): string => {
    const settings = settingsStore.get();
    return settings.dataDir || path.join(app.getPath('userData'), 'nadabodha-data');
  };
  const noteStore = new NoteStore(resolveDataDir());
  const reindexResult = noteStore.reindex();
  if (!reindexResult.success) {
    console.error(`[NoteStore] reindex failed: ${reindexResult.error}`);
  }
  // One-time migration: import any pre-existing transcript/summary files.
  noteStore.migrateFromLegacy();

  if (!mainWindow) {
    throw new Error('Main window not created');
  }

  const { dictation } = setupIpcHandlers({
    mainWindow,
    transcriptionService,
    recorder,
    settingsStore,
    noteStore,
  });

  // The global Option hook and global shortcuts must never outlive the app
  app.on('will-quit', () => {
    try {
      globalShortcut.unregisterAll();
    } catch {
      // ignore
    }
    if (dictation) {
      dictation.stop();
    }
  });

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
