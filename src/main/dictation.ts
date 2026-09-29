/**
 * System-wide "hold Option to dictate" input state machine.
 *
 * Everything environment-facing is injected — the uiohook hook, the clock,
 * the settings lookup and the macOS accessibility check — so the state
 * machine itself can be unit tested against a fake emitter
 * (see dictation.test.ts). Nothing here imports Electron.
 *
 * Behaviour implemented (approved plan, workstream 3):
 *   (a) bare Option keydown        -> actions.startTake()
 *   (b) any other key while held   -> actions.abortTake('chord'), never transcribed
 *   (c) Option keyup after >=300ms -> actions.finishTake(heldMs) -> transcription (append)
 *   (d) Option keydown while a take is open, or while the app is already
 *       recording/transcribing (canStartTake() === false) -> ignored
 *   (e) Option auto-repeat keydown -> ignored (state stays 'recording')
 *   (f) Option keyup before 300ms  -> actions.abortTake('too-short'), never transcribed
 */

/** uiohook-napi key event subset this state machine relies on. */
export interface DictationKeyEvent {
  /** 4 = key pressed, 5 = key released (uiohook EventType). */
  type: number;
  /** libuiohook virtual keycode. */
  keycode: number;
  altKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
  time?: number;
}

export const KEY_PRESSED = 4;
export const KEY_RELEASED = 5;

/**
 * libuiohook VC_ALT_L (0x38 === 56 === UiohookKey.Alt). Confirmed empirically
 * in the STEP-0 probe: a bare Option press arrives as keydown(keycode 56) and
 * its release as keyup(keycode 56), while a chord such as Option+ArrowLeft
 * arrives as a second, different keycode (57419) between those two events.
 */
export const OPTION_KEYCODE = 0x38;

/** Minimum hold time before a take is worth transcribing. */
export const MIN_HOLD_MS = 300;

/** Exact inline hint shown when a take is released too early. */
export const TOO_SHORT_NOTICE = 'Too short - hold the Option key to dictate';
/** Inline hint shown when another key interrupts a take. */
export const CHORD_NOTICE = 'Dictation cancelled - another key was pressed';

/** Minimal surface of the uiohook-napi singleton (`uIOhook`). */
export interface DictationHook {
  start(): void;
  stop(): void;
  on(event: 'keydown', listener: (e: DictationKeyEvent) => void): unknown;
  on(event: 'keyup', listener: (e: DictationKeyEvent) => void): unknown;
  off?(event: 'keydown' | 'keyup', listener: (e: DictationKeyEvent) => void): unknown;
}

export type DictationTakeReason = 'chord' | 'too-short';

/** Side effects the controller asks the app to perform. */
export interface DictationActions {
  /** Begin recording a dictation take. */
  startTake(): void;
  /** Discard the current take; it must never reach transcription. */
  abortTake(reason: DictationTakeReason): void;
  /** Stop the take and hand it to the transcription pipeline (append mode). */
  finishTake(heldMs: number): void;
}

export type DictationState = 'idle' | 'recording' | 'aborted';

export type DictationStartOutcome =
  | 'started'
  | 'disabled'
  | 'no-accessibility'
  | 'hook-error'
  | 'already-running';

export interface DictationStartResult {
  started: boolean;
  outcome: DictationStartOutcome;
  error?: string;
}

export interface DictationControllerOptions {
  hook: DictationHook;
  actions: DictationActions;
  /** Settings gate: dictationEnabled (default ON). */
  isDictationEnabled(): boolean;
  /**
   * macOS crash guard. libuiohook takes an event tap that aborts the process
   * when the app is not trusted for Accessibility, so this must be checked
   * (with ask === false, i.e. without showing a prompt) BEFORE hook.start().
   */
  isTrustedAccessibilityClient(ask: boolean): boolean;
  /** False while the app is already recording or transcribing. */
  canStartTake(): boolean;
  now?(): number;
  minHoldMs?: number;
}

export function describeDictationFailure(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class DictationController {
  private readonly hook: DictationHook;
  private readonly actions: DictationActions;
  private readonly isDictationEnabled: () => boolean;
  private readonly isTrustedAccessibilityClient: (ask: boolean) => boolean;
  private readonly canStartTakeFn: () => boolean;
  private readonly now: () => number;
  private readonly minHoldMs: number;

  private state: DictationState = 'idle';
  private holdStartedAt = 0;
  private running = false;
  private lastOutcome: DictationStartOutcome = 'disabled';
  private keyDownListener: ((e: DictationKeyEvent) => void) | null = null;
  private keyUpListener: ((e: DictationKeyEvent) => void) | null = null;

  constructor(options: DictationControllerOptions) {
    this.hook = options.hook;
    this.actions = options.actions;
    this.isDictationEnabled = options.isDictationEnabled;
    this.isTrustedAccessibilityClient = options.isTrustedAccessibilityClient;
    this.canStartTakeFn = options.canStartTake;
    this.now = options.now ?? Date.now;
    this.minHoldMs = options.minHoldMs ?? MIN_HOLD_MS;
  }

  /**
   * Start listening for the Option key. Never starts the hook when dictation
   * is switched off or the app is not trusted for Accessibility.
   */
  start(): DictationStartResult {
    if (this.running) {
      this.lastOutcome = 'already-running';
      return { started: false, outcome: 'already-running' };
    }
    if (!this.isDictationEnabled()) {
      this.lastOutcome = 'disabled';
      return { started: false, outcome: 'disabled' };
    }

    // Crash guard: check BEFORE the hook is created/started. A failing check
    // must leave the hook untouched, not merely ignored afterwards.
    let trusted = false;
    try {
      trusted = this.isTrustedAccessibilityClient(false);
    } catch {
      trusted = false;
    }
    if (!trusted) {
      this.lastOutcome = 'no-accessibility';
      return { started: false, outcome: 'no-accessibility' };
    }

    this.keyDownListener = (e) => this.handleKeyDown(e);
    this.keyUpListener = (e) => this.handleKeyUp(e);
    this.hook.on('keydown', this.keyDownListener);
    this.hook.on('keyup', this.keyUpListener);

    try {
      this.hook.start();
    } catch (err) {
      this.detachListeners();
      this.lastOutcome = 'hook-error';
      return { started: false, outcome: 'hook-error', error: describeDictationFailure(err) };
    }

    this.running = true;
    this.state = 'idle';
    this.holdStartedAt = 0;
    this.lastOutcome = 'started';
    return { started: true, outcome: 'started' };
  }

  /** Stop the hook and forget listeners. Safe to call repeatedly. */
  stop(): void {
    const wasRunning = this.running;
    this.running = false;
    this.state = 'idle';
    this.detachListeners();
    if (wasRunning) {
      try {
        this.hook.stop();
      } catch {
        // Already stopped / never started: nothing to undo.
      }
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  getState(): DictationState {
    return this.state;
  }

  getLastOutcome(): DictationStartOutcome {
    return this.lastOutcome;
  }

  handleKeyDown(event: DictationKeyEvent): void {
    if (!this.running) return;

    if (event.keycode === OPTION_KEYCODE) {
      // (d) + (e): an Option press is only meaningful from a clean idle state.
      // Any repeat while the take is open, and any press while the app is
      // already busy, is dropped.
      if (this.state !== 'idle') return;
      if (!this.canStartTakeFn()) return;
      this.state = 'recording';
      this.holdStartedAt = this.now();
      this.actions.startTake();
      return;
    }

    // (b): any other key while the take is open means the user is invoking a
    // real shortcut (Option+Arrow, Option+Tab, ...) — drop the take.
    if (this.state === 'recording') {
      this.state = 'aborted';
      this.actions.abortTake('chord');
    }
  }

  handleKeyUp(event: DictationKeyEvent): void {
    if (!this.running) return;

    if (event.keycode === OPTION_KEYCODE) {
      if (this.state === 'recording') {
        const heldMs = this.now() - this.holdStartedAt;
        this.state = 'idle';
        if (heldMs < this.minHoldMs) {
          // (f): too short to be worth transcribing.
          this.actions.abortTake('too-short');
        } else {
          // (c): stop + transcribe, appending to the transcript.
          this.actions.finishTake(heldMs);
        }
        return;
      }
      if (this.state === 'aborted') {
        this.state = 'idle';
      }
      return;
    }

    // A key still held when Option went down is released now: it belongs to
    // the same chord, so the take stays aborted / never transcribes.
    if (this.state === 'recording') {
      this.state = 'aborted';
      this.actions.abortTake('chord');
    }
  }

  private detachListeners(): void {
    if (this.keyDownListener && typeof this.hook.off === 'function') {
      this.hook.off('keydown', this.keyDownListener);
    }
    if (this.keyUpListener && typeof this.hook.off === 'function') {
      this.hook.off('keyup', this.keyUpListener);
    }
    this.keyDownListener = null;
    this.keyUpListener = null;
  }
}
