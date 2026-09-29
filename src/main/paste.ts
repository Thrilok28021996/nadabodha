import { clipboard, BrowserWindow } from 'electron';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Checks if macOS Secure Input is enabled (e.g. user is in a password field).
 * We do not want to paste into password fields.
 */
export async function isSecureInputEnabled(): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  try {
    // Use ioreg which is fast enough (~100-200ms) and built-in
    const { stdout } = await execAsync('ioreg -l -w 0 | grep -i SecureInput', { timeout: 1000 });
    return stdout.includes('SecureInput');
  } catch (err) {
    // grep returns exit code 1 if not found, which throws an error
    return false;
  }
}

/**
 * Executes a paste using uiohook-napi to send Cmd+V.
 * The hook must already be loaded and running.
 */
export async function pasteTextAtCursor(text: string): Promise<'pasted' | 'secure-input' | 'own-window' | 'error'> {
  if (!text) return 'error';

  // 1. Guard rail: don't paste if secure input is enabled
  const secure = await isSecureInputEnabled();
  if (secure) {
    console.log('[paste] Secure input enabled, skipping paste');
    return 'secure-input'; // Skip paste
  }

  // 2. Guard rail: don't paste if our own window has focus
  const focusedWin = BrowserWindow.getFocusedWindow();
  if (focusedWin) {
    console.log('[paste] Our window has focus, skipping programmatic paste to avoid doubling');
    return 'own-window';
  }

  // Ensure uiohook is available
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  let uIOhook;
  try {
    const mod = require('uiohook-napi');
    uIOhook = mod.uIOhook;
  } catch {
    return 'error';
  }

  if (!uIOhook) return 'error';

  // 3. Save current clipboard
  const previousText = clipboard.readText();
  
  // 4. Write transcript to clipboard
  clipboard.writeText(text);

  // 5. Synthesize Cmd+V
  // Give the OS a tiny moment to register the clipboard change
  await new Promise(resolve => setTimeout(resolve, 50));
  
  // UiohookKey.V = 47, UiohookKey.Meta = 3675
  // We press Cmd down, V down, V up, Cmd up
  uIOhook.keyToggle(3675, 'down');
  uIOhook.keyTap(47);
  uIOhook.keyToggle(3675, 'up');

  // 6. Restore previous clipboard after a short delay
  setTimeout(() => {
    clipboard.writeText(previousText || '');
  }, 500);

  return 'pasted';
}
