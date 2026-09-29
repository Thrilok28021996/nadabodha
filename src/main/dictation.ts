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
 *   (g) the hook stopping with a take open (app quit, dictationEnabled off,
 *       hook error/stop, or native silence beyond HOOK_SILENCE_TIMEOUT_MS)
 *       -> actions.abortTake('hook-stopped') so the recorder is cancelled
 *       and the state machine returns to 'idle' (MEDIUM-1 / MEDIUM-2)
 *   (h) Accessibility trust flipping false->true -> reconcileAccessibility()
 *       runs the guarded start (BLOCKING-1)
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

/**
 * Lost-event watchdog for an open take (review finding MEDIUM-2).
 *
 * uiohook-napi 1.5.5 never surfaces the native hook's own disable event to
 * JavaScript (EVENT_HOOK_DISABLED is consumed inside
 * node_modules/uiohook-napi/src/lib/uiohook_worker.c), so a hook that dies
 * silently — or an Option keyup that never arrives — leaves the state machine
 * in 'recording' with a live recorder and no event that will ever call it
 * back. While a take is open, a healthy hook keeps delivering the auto-repeat
 * keydown of the held Option key (and an 'input' event for any other native
 * event), so native silence for this long means the event stream is gone.
 *
 * The threshold sits well above the slowest configurable macOS key-repeat
 * delay (sub-second in System Settings, a few seconds even at the extreme
 * `InitialKeyRepeat` value), so a healthy hold never trips it, while an
 * orphaned capture is bounded to this many milliseconds. It is the only
 * timer in this file, and it is armed only while a take is open.
 */
export const HOOK_SILENCE_TIMEOUT_MS = 10_000;

/** Minimal surface of the uiohook-napi singleton (`uIOhook`). */
export interface DictationHook {
  start(): void;
  stop(): void;
  on(event: 'keydown', listener: (e: DictationKeyEvent) => void): unknown;
  on(event: 'keyup', listener: (e: DictationKeyEvent) => void): unknown;
  /** Every native event the hook sees: used as a liveness signal only. */
  on(event: 'input', listener: () => void): unknown;
  /**
   * Hook-level failure signals. uiohook-napi 1.5.5 never emits them today,
   * but subscribing is what keeps a future 'error' emit from crashing the
   * main process (EventEmitter rethrows an unhandled 'error') and it is the
   * hook's own way of saying "events are being lost" (MEDIUM-2).
   */
  on(event: 'error', listener: () => void): unknown;
  on(event: 'stop', listener: () => void): unknown;
  off?(event: 'keydown' | 'keyup', listener: (e: DictationKeyEvent) => void): unknown;
  off?(event: 'input' | 'error' | 'stop', listener: () => void): unknown;
}

/**
 * Why a take was dropped without transcribing. 'hook-stopped' is the take the
 * controller itself discards when the input hook goes away with a take open
 * (app quit, dictationEnabled switched off, a hook error/stop event, or a
 * native event stream that went silent): the recorder must be cancelled, but
 * neither approved inline hint ('another key was pressed' / 'too short')
 * applies, so it carries no notice.
 */
export type DictationTakeReason = 'chord' | 'too-short' | 'hook-stopped';

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
  /**
   * Timer scheduling for the lost-event watchdog, injected so tests can drive
   * it deterministically. Defaults to setTimeout (unref'd) / clearTimeout.
   */
  scheduleWatchdog?: (callback: () => void, ms: number) => NodeJS.Timeout;
  cancelWatchdog?: (handle: NodeJS.Timeout) => void;
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
  private readonly scheduleWatchdog: (callback: () => void, ms: number) => NodeJS.Timeout;
  private readonly cancelWatchdog: (handle: NodeJS.Timeout) => void;

  private state: DictationState = 'idle';
  private holdStartedAt = 0;
  private running = false;
  private lastOutcome: DictationStartOutcome = 'disabled';
  /** Last trust state the guard/reconcile saw; drives the false->true start. */
  private wasTrusted = false;
  private keyDownListener: ((e: DictationKeyEvent) => void) | null = null;
  private keyUpListener: ((e: DictationKeyEvent) => void) | null = null;
  private hookInputListener: (() => void) | null = null;
  private hookFailureListener: (() => void) | null = null;
  private watchdogHandle: NodeJS.Timeout | null = null;

  constructor(options: DictationControllerOptions) {
    this.hook = options.hook;
    this.actions = options.actions;
    this.isDictationEnabled = options.isDictationEnabled;
    this.isTrustedAccessibilityClient = options.isTrustedAccessibilityClient;
    this.canStartTakeFn = options.canStartTake;
    this.now = options.now ?? Date.now;
    this.minHoldMs = options.minHoldMs ?? MIN_HOLD_MS;
    this.scheduleWatchdog =
      options.scheduleWatchdog ??
      ((callback: () => void, ms: number): NodeJS.Timeout => {
        const handle = setTimeout(callback, ms);
        // A pending watchdog must never be what keeps the process alive.
        handle.unref();
        return handle;
      });
    this.cancelWatchdog = options.cancelWatchdog ?? ((handle: NodeJS.Timeout) => clearTimeout(handle));
  }

  /**
   * Start listening for the Option key. Never starts the hook when dictation
   * is switched off or the app is not trusted for Accessibility.
   *
   * Every start path in the app funnels through here, and the Accessibility
   * guard is the last thing evaluated before hook.start() — a stale check
   * from an earlier attempt can never let the hook start (BLOCKING-1).
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

    this.keyDownListener = (e) => this.handleKeyDown(e);
    this.keyUpListener = (e) => this.handleKeyUp(e);
    this.hookInputListener = () => this.syncWatchdog();
    this.hookFailureListener = () => this.handleHookFailure();
    this.hook.on('keydown', this.keyDownListener);
    this.hook.on('keyup', this.keyUpListener);
    this.hook.on('input', this.hookInputListener);
    this.hook.on('error', this.hookFailureListener);
    this.hook.on('stop', this.hookFailureListener);

    // Crash guard: libuiohook takes an event tap that aborts the process when
    // the app is not trusted for Accessibility, so the check (ask === false,
    // no prompt) runs immediately before hook.start() on every start path. A
    // failing check unwires the listeners again, leaving the hook untouched.
    let trusted = false;
    try {
      trusted = this.isTrustedAccessibilityClient(false);
    } catch {
      trusted = false;
    }
    this.wasTrusted = trusted;
    if (!trusted) {
      this.detachListeners();
      this.lastOutcome = 'no-accessibility';
      return { started: false, outcome: 'no-accessibility' };
    }

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
    this.clearWatchdog();
    this.lastOutcome = 'started';
    return { started: true, outcome: 'started' };
  }

  /**
   * Re-read Accessibility trust and run the guarded start when trust has just
   * flipped false->true (review finding BLOCKING-1).
   *
   * The renderer's post-grant polling reaches this through the status IPC, so
   * whichever side first observes the grant turns it into a start without the
   * user toggling anything. Each transition triggers exactly one start attempt;
   * start() itself re-checks trust immediately before hook.start().
   */
  reconcileAccessibility(): void {
    let trusted = false;
    try {
      trusted = this.isTrustedAccessibilityClient(false);
    } catch {
      trusted = false;
    }
    const wasTrusted = this.wasTrusted;
    this.wasTrusted = trusted;
    if (!trusted || wasTrusted) {
      return;
    }
    this.start();
  }

  /**
   * Stop the hook and forget listeners. Safe to call repeatedly.
   *
   * If a take is open when the hook stops — app quit, the dictationEnabled
   * switch, any other caller — the take is aborted first-class so the
   * recorder is cancelled and ffmpeg cannot outlive the hook (MEDIUM-1).
   */
  stop(): void {
    const wasRunning = this.running;
    const takeOpen = this.state === 'recording';
    this.running = false;
    this.state = 'idle';
    this.holdStartedAt = 0;
    this.clearWatchdog();
    this.detachListeners();
    if (wasRunning) {
      try {
        this.hook.stop();
      } catch {
        // Already stopped / never started: nothing to undo.
      }
    }
    if (takeOpen) {
      this.actions.abortTake('hook-stopped');
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
    this.processKeyDown(event);
    this.syncWatchdog();
  }

  handleKeyUp(event: DictationKeyEvent): void {
    this.processKeyUp(event);
    this.syncWatchdog();
  }

  private processKeyDown(event: DictationKeyEvent): void {
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

  private processKeyUp(event: DictationKeyEvent): void {
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

  /**
   * Re-arm the lost-event watchdog after every native event (MEDIUM-2).
   *
   * Armed only while a take is open; any hook activity postpones it, so it
   * fires exclusively on native silence — the signature of a hook that died
   * (or an Option keyup that was lost) without telling anyone.
   */
  private syncWatchdog(): void {
    this.clearWatchdog();
    if (!this.running || this.state === 'idle') {
      return;
    }
    this.watchdogHandle = this.scheduleWatchdog(() => {
      this.watchdogHandle = null;
      this.handleHookSilence();
    }, HOOK_SILENCE_TIMEOUT_MS);
  }

  private clearWatchdog(): void {
    if (this.watchdogHandle !== null) {
      this.cancelWatchdog(this.watchdogHandle);
      this.watchdogHandle = null;
    }
  }

  /** Native silence with a take open: cancel the take, back to idle. */
  private handleHookSilence(): void {
    if (this.state === 'idle') {
      return;
    }
    const wasRecording = this.state === 'recording';
    this.state = 'idle';
    this.holdStartedAt = 0;
    if (wasRecording) {
      this.actions.abortTake('hook-stopped');
    }
  }

  /**
   * The hook itself reported an error/stopped emitting (MEDIUM-2).
   *
   * Fail closed: whatever it was reporting, events are no longer trustworthy,
   * so the open take is cancelled, the state machine returns to idle and the
   * controller stops tracking a hook it can no longer hear. The next guarded
   * start (settings re-enable, app restart) brings it back.
   */
  private handleHookFailure(): void {
    const wasRunning = this.running;
    const takeOpen = this.state === 'recording';
    this.running = false;
    this.state = 'idle';
    this.holdStartedAt = 0;
    this.clearWatchdog();
    this.detachListeners();
    if (wasRunning) {
      try {
        this.hook.stop();
      } catch {
        // Already stopped: nothing to undo.
      }
    }
    this.lastOutcome = 'hook-error';
    if (takeOpen) {
      this.actions.abortTake('hook-stopped');
    }
  }

  private detachListeners(): void {
    if (typeof this.hook.off === 'function') {
      if (this.keyDownListener) {
        this.hook.off('keydown', this.keyDownListener);
      }
      if (this.keyUpListener) {
        this.hook.off('keyup', this.keyUpListener);
      }
      if (this.hookInputListener) {
        this.hook.off('input', this.hookInputListener);
      }
      if (this.hookFailureListener) {
        this.hook.off('error', this.hookFailureListener);
        this.hook.off('stop', this.hookFailureListener);
      }
    }
    this.keyDownListener = null;
    this.keyUpListener = null;
    this.hookInputListener = null;
    this.hookFailureListener = null;
  }
}
