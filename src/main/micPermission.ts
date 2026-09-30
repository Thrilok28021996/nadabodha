import { systemPreferences } from 'electron';

/**
 * Microphone permission gate for recording (macOS TCC).
 *
 * Spawning ffmpeg without microphone access fails inside avfoundation with a
 * cryptic capture-device error (or a hung device open), so the permission is
 * checked/requested before any capture process starts, and a denial is
 * reported as actionable guidance. When a capture fails anyway, ffmpeg's
 * stderr is mapped to the same guidance with its own detail kept as the
 * secondary text.
 */

/** Actionable guidance shown for every microphone denial. */
export const MICROPHONE_DENIED_MESSAGE =
  'Microphone access denied. Allow it in System Settings > Privacy & Security > Microphone, then try again.';

export interface MicrophonePermissionResult {
  granted: boolean;
}

/**
 * The Electron `systemPreferences` accessors this gate uses, declared
 * structurally so they can be feature-detected: `getCurrentApplicationMediaAccessState`
 * is not present in every Electron line (it is absent in Electron 33), and
 * `askForMediaAccess` is macOS-only.
 */
interface MediaAccessSystemPreferences {
  getCurrentApplicationMediaAccessState?: (mediaType: 'microphone' | 'camera' | 'screen') => string;
  getMediaAccessStatus?: (mediaType: 'microphone' | 'camera' | 'screen') => string;
  askForMediaAccess?: (mediaType: 'microphone' | 'camera' | 'screen') => Promise<boolean>;
}

/** Current app-level microphone state, or undefined when no API exists. */
function currentMediaAccessState(sp: MediaAccessSystemPreferences): string | undefined {
  if (typeof sp.getCurrentApplicationMediaAccessState === 'function') {
    return sp.getCurrentApplicationMediaAccessState('microphone');
  }
  if (typeof sp.getMediaAccessStatus === 'function') {
    return sp.getMediaAccessStatus('microphone');
  }
  return undefined;
}

/**
 * Confirm (requesting if needed) that this app may use the microphone.
 *
 * Returns `granted: false` — meaning "do not spawn the recorder" — when the
 * OS reports `denied`/`restricted`, when an explicit request answers false,
 * or when a permission API throws (permission unavailable). A platform with
 * no permission API at all proceeds: a blocked capture device is still
 * mapped to the same guidance from ffmpeg's stderr.
 */
export async function ensureMicrophonePermission(): Promise<MicrophonePermissionResult> {
  const sp = systemPreferences as MediaAccessSystemPreferences | undefined;
  if (!sp) {
    return { granted: true };
  }
  try {
    const state = currentMediaAccessState(sp);
    if (state === 'granted') {
      return { granted: true };
    }
    if (state === 'denied' || state === 'restricted') {
      return { granted: false };
    }
    // `not-determined` (or an unreadable state): ask the OS explicitly, which
    // shows the one-time system prompt. An already-denied request never
    // prompts again and simply resolves false.
    if (typeof sp.askForMediaAccess === 'function') {
      return { granted: (await sp.askForMediaAccess('microphone')) === true };
    }
    return { granted: true };
  } catch {
    // The permission API refused to answer: treat as unavailable rather than
    // spawning ffmpeg into a failure the user cannot act on.
    return { granted: false };
  }
}

/**
 * True when ffmpeg's stderr shows avfoundation could not open the capture
 * device — the signature of a microphone this app may not use.
 */
export function isMicrophoneCaptureFailure(stderr: string): boolean {
  const text = stderr.toLowerCase();
  if (!text.includes('avfoundation')) {
    return false;
  }
  return (
    text.includes('cannot') ||
    text.includes('could not') ||
    text.includes('failed') ||
    text.includes('error opening input') ||
    text.includes('denied') ||
    text.includes('not permitted') ||
    text.includes('not authorized') ||
    text.includes('unavailable') ||
    text.includes('no such device')
  );
}

/**
 * Compose the failure message the UI shows for a failed capture.
 *
 * When (and only when) stderr shows a blocked capture device, the actionable
 * microphone guidance leads and the original message — ffmpeg's
 * `Recording failed: <stderr>` detail — stays as the secondary text, so no
 * technical context is lost. Idempotent: an already-guided message is
 * returned unchanged.
 */
export function friendlyRecordingFailure(message: string, stderr: string): string {
  if (message.startsWith(MICROPHONE_DENIED_MESSAGE)) {
    return message;
  }
  if (!isMicrophoneCaptureFailure(stderr)) {
    return message;
  }
  return `${MICROPHONE_DENIED_MESSAGE} ${message}`;
}

export const SCREEN_DENIED_MESSAGE =
  'Screen & System Audio Recording access denied. Allow it in System Settings > Privacy & Security > Screen Recording, then try again.';

export async function ensureScreenPermission(): Promise<{ granted: boolean }> {
  const sp = systemPreferences as MediaAccessSystemPreferences | undefined;
  if (!sp) {
    return { granted: true };
  }
  try {
    const state = typeof sp.getMediaAccessStatus === 'function' ? sp.getMediaAccessStatus('screen') : undefined;
    if (state === 'granted') {
      return { granted: true };
    }
    if (state === 'denied' || state === 'restricted') {
      return { granted: false };
    }
    if (typeof sp.askForMediaAccess === 'function') {
      return { granted: (await sp.askForMediaAccess('screen')) === true };
    }
    return { granted: true };
  } catch {
    return { granted: false };
  }
}
