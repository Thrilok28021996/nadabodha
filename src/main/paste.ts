import { clipboard, BrowserWindow, app } from 'electron';
import fs from 'fs';
import path from 'path';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

/**
 * Resolves the path to the native mac-paste binary helper.
 */
export function resolveMacPasteHelper(): string {
  if (process.platform !== 'darwin') return '';
  const candidates: string[] = [];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'assets', 'bin', 'mac-paste'));
    candidates.push(path.join(process.resourcesPath, 'app', 'assets', 'bin', 'mac-paste'));
    candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', 'bin', 'mac-paste'));
  }
  candidates.push(path.join(__dirname, '../../assets/bin/mac-paste'));
  candidates.push(path.join(__dirname, '../assets/bin/mac-paste'));
  try {
    if (app && typeof app.getAppPath === 'function') {
      candidates.push(path.join(app.getAppPath(), 'assets', 'bin', 'mac-paste'));
    }
  } catch { /* ignore */ }

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return c;
    }
  }
  return '';
}

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
 * Otherwise, synthesizes Cmd+V via native CoreGraphics CGEventPost or AppleScript.
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

  // Short delay (80ms) to ensure OS pasteboard synchronization has completed
  await new Promise(resolve => setTimeout(resolve, 80));

  // 4. Primary: use native macOS CGEventPost helper binary (native hardware Cmd+V)
  const helper = resolveMacPasteHelper();
  if (helper) {
    try {
      await execFileAsync(helper, { timeout: 1500 });
      console.log('[paste] Native CGEventPost helper executed Cmd+V successfully');
      return 'pasted';
    } catch (err) {
      console.warn('[paste] Native helper failed, trying AppleScript fallback:', err);
    }
  }

  // 5. Secondary fallback: AppleScript virtual key code 9 (V) with command down
  if (process.platform === 'darwin') {
    try {
      await execAsync("/usr/bin/osascript -e 'tell application \"System Events\" to key code 9 using command down'", { timeout: 1500 });
      console.log('[paste] AppleScript key code 9 executed successfully');
      return 'pasted';
    } catch (err) {
      console.warn('[paste] AppleScript paste also bypassed; text is ready on clipboard:', err);
    }
  }

  return 'pasted';
}
