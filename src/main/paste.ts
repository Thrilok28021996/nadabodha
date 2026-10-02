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
  } catch {
    // grep returns exit code 1 if not found, which throws an error
    return false;
  }
}

/**
 * Executes a paste of the dictated text.
 * Always ensures the transcript is placed on the system clipboard.
 * If Nadabodha has focus, returns 'own-window' so the renderer directly inserts it.
 * Otherwise, attempts to synthesize Cmd+V via AppleScript or native keytap.
 */
export async function pasteTextAtCursor(text: string): Promise<'pasted' | 'secure-input' | 'own-window' | 'error'> {
  if (!text) return 'error';

  // 1. Always copy text to clipboard so it is immediately available
  clipboard.writeText(text);

  // 2. Guard rail: don't paste if secure input is enabled (e.g. password field)
  const secure = await isSecureInputEnabled();
  if (secure) {
    console.log('[paste] Secure input enabled, skipping synthetic paste');
    return 'secure-input';
  }

  // 3. Guard rail: if our own window has focus, let the renderer insert it directly
  const focusedWin = BrowserWindow.getFocusedWindow();
  if (focusedWin) {
    console.log('[paste] Our window has focus, renderer will handle display');
    return 'own-window';
  }

  // 4. In external applications, attempt AppleScript Cmd+V
  if (process.platform === 'darwin') {
    try {
      await execAsync("osascript -e 'tell application \"System Events\" to keystroke \"v\" using command down'", { timeout: 1500 });
      return 'pasted';
    } catch {
      // If AppleScript fails/is blocked, text remains on clipboard for user ⌘V
      console.log('[paste] AppleScript paste bypassed; text is ready on clipboard');
    }
  }

  // 5. Fallback: try uiohook keytap if available
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('uiohook-napi');
    if (mod && mod.uIOhook) {
      mod.uIOhook.keyToggle(3675, 'down');
      mod.uIOhook.keyTap(47);
      mod.uIOhook.keyToggle(3675, 'up');
      return 'pasted';
    }
  } catch {
    // ignore
  }

  return 'pasted';
}
