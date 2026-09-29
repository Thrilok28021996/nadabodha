import { EventEmitter } from 'events';
import {
  CHORD_NOTICE,
  DictationActions,
  DictationController,
  DictationHook,
  DictationKeyEvent,
  DictationTakeReason,
  HOOK_SILENCE_TIMEOUT_MS,
  KEY_PRESSED,
  KEY_RELEASED,
  MIN_HOLD_MS,
  OPTION_KEYCODE,
  TOO_SHORT_NOTICE,
} from './dictation';

/** Fake uiohook emitter: same `on`/`off` surface as the real singleton. */
class FakeHook extends EventEmitter implements DictationHook {
  startCalls = 0;
  stopCalls = 0;
  failOnStart = false;
  /** Shared with the harness so call order across objects can be asserted. */
  order: string[] = [];

  start(): void {
    this.startCalls += 1;
    this.order.push('hook.start');
    if (this.failOnStart) {
      throw new Error('hook refused to start');
    }
  }

  stop(): void {
    this.stopCalls += 1;
  }

  press(keycode: number, at?: number): void {
    this.emit('keydown', { type: KEY_PRESSED, keycode, time: at } as DictationKeyEvent);
  }

  release(keycode: number, at?: number): void {
    this.emit('keyup', { type: KEY_RELEASED, keycode, time: at } as DictationKeyEvent);
  }

  listenerCountFor(event: 'keydown' | 'keyup' | 'input' | 'error' | 'stop'): number {
    return this.listenerCount(event);
  }
}

interface RecordedCall {
  action: 'startTake' | 'abortTake' | 'finishTake';
  reason?: DictationTakeReason;
  heldMs?: number;
}

/** A watchdog tick the controller scheduled (injected instead of a real timer). */
interface PendingWatchdog {
  callback: () => void;
  ms: number;
}

interface Harness {
  hook: FakeHook;
  controller: DictationController;
  calls: RecordedCall[];
  clock: { value: number };
  /** Watchdogs still pending (cancelled ones are removed). */
  watchdogs: PendingWatchdog[];
  /** Fire every pending watchdog tick; true when at least one fired. */
  fireWatchdog(): boolean;
  options: {
    enabled: boolean;
    trusted: boolean;
    canStart: boolean;
    trustChecks: boolean[];
    hookStartOrder: string[];
  };
}

function harness(overrides: Partial<{ enabled: boolean; trusted: boolean; canStart: boolean; failOnStart: boolean }> = {}): Harness {
  const hook = new FakeHook();
  const calls: RecordedCall[] = [];
  const clock = { value: 1_000 };
  const watchdogs: PendingWatchdog[] = [];
  const options = {
    enabled: overrides.enabled ?? true,
    trusted: overrides.trusted ?? true,
    canStart: overrides.canStart ?? true,
    trustChecks: [] as boolean[],
    hookStartOrder: [] as string[],
  };
  hook.order = options.hookStartOrder;

  const actions: DictationActions = {
    startTake: () => {
      calls.push({ action: 'startTake' });
      options.hookStartOrder.push('startTake');
    },
    abortTake: (reason) => {
      calls.push({ action: 'abortTake', reason });
    },
    finishTake: (heldMs) => {
      calls.push({ action: 'finishTake', heldMs });
    },
  };

  hook.failOnStart = overrides.failOnStart ?? false;

  const controller = new DictationController({
    hook,
    actions,
    isDictationEnabled: () => options.enabled,
    isTrustedAccessibilityClient: (ask) => {
      options.trustChecks.push(ask);
      options.hookStartOrder.push('trust-check');
      if (!options.trusted) return false;
      return true;
    },
    canStartTake: () => options.canStart,
    now: () => clock.value,
    minHoldMs: MIN_HOLD_MS,
    scheduleWatchdog: (callback, ms) => {
      const entry: PendingWatchdog = { callback, ms };
      watchdogs.push(entry);
      return entry as unknown as NodeJS.Timeout;
    },
    cancelWatchdog: (handle) => {
      const entry = handle as unknown as PendingWatchdog;
      const index = watchdogs.indexOf(entry);
      if (index >= 0) watchdogs.splice(index, 1);
    },
  });

  const fireWatchdog = (): boolean => {
    const pending = watchdogs.splice(0, watchdogs.length);
    pending.forEach((entry) => entry.callback());
    return pending.length > 0;
  };

  return { hook, controller, calls, clock, watchdogs, fireWatchdog, options };
}

const actionsOf = (calls: RecordedCall[]) => calls.map((c) => c.action);

describe('DictationController: bare Option take', () => {
  it('starts a take on a bare Option keydown and transcribes on release', () => {
    const h = harness();
    expect(h.controller.start().started).toBe(true);

    h.clock.value = 5_000;
    h.hook.press(OPTION_KEYCODE);
    expect(h.controller.getState()).toBe('recording');
    expect(actionsOf(h.calls)).toEqual(['startTake']);

    h.clock.value = 5_000 + 650;
    h.hook.release(OPTION_KEYCODE);
    expect(h.controller.getState()).toBe('idle');
    expect(actionsOf(h.calls)).toEqual(['startTake', 'finishTake']);
    expect(h.calls[1].heldMs).toBe(650);
  });

  it('ignores Option keydown while the app is already recording/transcribing', () => {
    const h = harness({ canStart: false });
    expect(h.controller.start().started).toBe(true);

    h.hook.press(OPTION_KEYCODE);
    expect(h.calls).toEqual([]);
    expect(h.controller.getState()).toBe('idle');

    h.hook.release(OPTION_KEYCODE);
    expect(h.calls).toEqual([]);
  });
});

describe('DictationController: chord cancel', () => {
  it('aborts the take when another key is pressed while Option is held', () => {
    const h = harness();
    h.controller.start();

    h.hook.press(OPTION_KEYCODE);
    h.clock.value += 250;
    h.hook.press(0xe04b); // ArrowLeft
    expect(actionsOf(h.calls)).toEqual(['startTake', 'abortTake']);
    expect(h.calls[1].reason).toBe('chord');

    h.clock.value += 1_000;
    h.hook.release(OPTION_KEYCODE);
    // Releasing Option after a chord must not transcribe anything.
    expect(actionsOf(h.calls)).toEqual(['startTake', 'abortTake']);
    expect(h.controller.getState()).toBe('idle');
  });

  it('aborts when a key held before Option is released during the take', () => {
    const h = harness();
    h.controller.start();

    h.hook.press(OPTION_KEYCODE);
    h.clock.value += 400;
    h.hook.release(0xe04b);
    expect(h.calls.map((c) => c.action)).toEqual(['startTake', 'abortTake']);
    expect(h.controller.getState()).toBe('aborted');

    h.hook.release(OPTION_KEYCODE);
    expect(h.controller.getState()).toBe('idle');
    expect(actionsOf(h.calls)).not.toContain('finishTake');
  });

  it('starts a fresh take on the next bare Option press after an abort', () => {
    const h = harness();
    h.controller.start();

    h.hook.press(OPTION_KEYCODE);
    h.hook.press(0xe04b);
    h.hook.release(OPTION_KEYCODE);

    h.clock.value += 800;
    h.hook.press(OPTION_KEYCODE);
    h.clock.value += 500;
    h.hook.release(OPTION_KEYCODE);

    expect(actionsOf(h.calls)).toEqual([
      'startTake',
      'abortTake',
      'startTake',
      'finishTake',
    ]);
    expect(h.calls[3].heldMs).toBe(500);
  });
});

describe('DictationController: auto-repeat guard', () => {
  it('opens only one take when Option keydown repeats', () => {
    const h = harness();
    h.controller.start();

    h.hook.press(OPTION_KEYCODE);
    h.clock.value += 30;
    h.hook.press(OPTION_KEYCODE);
    h.clock.value += 30;
    h.hook.press(OPTION_KEYCODE);
    expect(actionsOf(h.calls)).toEqual(['startTake']);

    h.clock.value += 500;
    h.hook.release(OPTION_KEYCODE);
    expect(actionsOf(h.calls)).toEqual(['startTake', 'finishTake']);
    expect(h.calls[1].heldMs).toBe(560);
  });

  it('ignores an Option release that never opened a take', () => {
    const h = harness({ canStart: false });
    h.controller.start();
    h.hook.release(OPTION_KEYCODE);
    expect(h.calls).toEqual([]);
  });
});

describe('DictationController: short take discard', () => {
  it(`discards a take released before ${MIN_HOLD_MS}ms`, () => {
    const h = harness();
    h.controller.start();

    h.clock.value = 9_000;
    h.hook.press(OPTION_KEYCODE);
    h.clock.value = 9_000 + 200;
    h.hook.release(OPTION_KEYCODE);

    expect(actionsOf(h.calls)).toEqual(['startTake', 'abortTake']);
    expect(h.calls[1].reason).toBe('too-short');
    expect(h.controller.getState()).toBe('idle');
  });

  it('transcribes a take released exactly at the threshold', () => {
    const h = harness();
    h.controller.start();
    h.hook.press(OPTION_KEYCODE);
    h.clock.value += MIN_HOLD_MS;
    h.hook.release(OPTION_KEYCODE);
    expect(actionsOf(h.calls)).toEqual(['startTake', 'finishTake']);
    expect(h.calls[1].heldMs).toBe(MIN_HOLD_MS);
  });
});

describe('DictationController: start guards', () => {
  it('never starts the hook when dictation is disabled', () => {
    const h = harness({ enabled: false });
    const result = h.controller.start();

    expect(result.started).toBe(false);
    expect(result.outcome).toBe('disabled');
    expect(h.hook.startCalls).toBe(0);
    expect(h.hook.listenerCountFor('keydown')).toBe(0);

    // Even a stray key event must not open a take.
    h.hook.press(OPTION_KEYCODE);
    expect(h.calls).toEqual([]);
  });

  it('never starts the hook when Accessibility is not trusted', () => {
    const h = harness({ trusted: false });
    const result = h.controller.start();

    expect(result.started).toBe(false);
    expect(result.outcome).toBe('no-accessibility');
    expect(h.hook.startCalls).toBe(0);
    expect(h.hook.listenerCountFor('keydown')).toBe(0);
    // The guard asks without prompting (ask === false) and runs before start().
    expect(h.options.trustChecks).toEqual([false]);
    expect(h.options.hookStartOrder[0]).toBe('trust-check');
  });

  it('treats a throwing accessibility check as untrusted', () => {
    const hook = new FakeHook();
    const controller = new DictationController({
      hook,
      actions: {
        startTake: () => undefined,
        abortTake: () => undefined,
        finishTake: () => undefined,
      },
      isDictationEnabled: () => true,
      isTrustedAccessibilityClient: () => {
        throw new Error('systemPreferences unavailable');
      },
      canStartTake: () => true,
    });

    const result = controller.start();
    expect(result.started).toBe(false);
    expect(result.outcome).toBe('no-accessibility');
    expect(hook.startCalls).toBe(0);
  });

  it('reports a hook that refuses to start and detaches its listeners', () => {
    const h = harness({ failOnStart: true });
    const result = h.controller.start();

    expect(result.started).toBe(false);
    expect(result.outcome).toBe('hook-error');
    expect(result.error).toContain('hook refused to start');
    expect(h.hook.listenerCountFor('keydown')).toBe(0);

    h.hook.press(OPTION_KEYCODE);
    expect(h.calls).toEqual([]);
  });

  it('stops the hook and ignores later key events', () => {
    const h = harness();
    h.controller.start();
    expect(h.hook.startCalls).toBe(1);

    h.controller.stop();
    expect(h.hook.stopCalls).toBe(1);
    expect(h.controller.isRunning()).toBe(false);
    expect(h.hook.listenerCountFor('keydown')).toBe(0);
    expect(h.hook.listenerCountFor('keyup')).toBe(0);

    h.hook.press(OPTION_KEYCODE);
    h.clock.value += 500;
    h.hook.release(OPTION_KEYCODE);
    expect(h.calls).toEqual([]);

    // stop() is idempotent and a restart works.
    h.controller.stop();
    expect(h.hook.stopCalls).toBe(1);
    expect(h.controller.start().started).toBe(true);
    expect(h.hook.startCalls).toBe(2);
    expect(h.hook.listenerCountFor('keydown')).toBe(1);
  });

  it('refuses a second start while running', () => {
    const h = harness();
    expect(h.controller.start().started).toBe(true);
    const second = h.controller.start();
    expect(second.started).toBe(false);
    expect(second.outcome).toBe('already-running');
    expect(h.hook.startCalls).toBe(1);
    // A duplicated listener would double every take: guard against it.
    expect(h.hook.listenerCountFor('keydown')).toBe(1);
  });
});

describe('DictationController: stop with a take open (MEDIUM-1)', () => {
  it('aborts the open take when the hook stops, so no recorder outlives it', () => {
    const h = harness();
    h.controller.start();

    h.hook.press(OPTION_KEYCODE);
    expect(h.controller.getState()).toBe('recording');

    h.controller.stop();

    // abortTake is what makes the app cancel the AudioRecorder; without it
    // ffmpeg kept capturing after the hook was gone.
    expect(actionsOf(h.calls)).toEqual(['startTake', 'abortTake']);
    expect(h.calls[1].reason).toBe('hook-stopped');
    expect(h.controller.getState()).toBe('idle');
    expect(h.controller.isRunning()).toBe(false);
    expect(h.hook.stopCalls).toBe(1);
    expect(h.watchdogs).toEqual([]); // no timer outlives the stop either

    // A released Option must not resurrect the aborted take.
    h.hook.release(OPTION_KEYCODE);
    expect(actionsOf(h.calls)).toEqual(['startTake', 'abortTake']);
  });

  it('does not abort anything when the hook stops without an open take', () => {
    const h = harness();
    h.controller.start();
    h.controller.stop();
    expect(h.calls).toEqual([]);
    expect(h.hook.stopCalls).toBe(1);
  });

  it('aborts once when stop() is called twice (will-quit + settings off)', () => {
    const h = harness();
    h.controller.start();
    h.hook.press(OPTION_KEYCODE);
    h.controller.stop();
    h.controller.stop();
    expect(actionsOf(h.calls)).toEqual(['startTake', 'abortTake']);
    expect(h.hook.stopCalls).toBe(1);
  });
});

describe('DictationController: lost native events (MEDIUM-2)', () => {
  it('cancels the take and returns to idle when the hook reports an error', () => {
    const h = harness();
    h.controller.start();
    h.hook.press(OPTION_KEYCODE);

    h.hook.emit('error', new Error('event tap died'));

    expect(actionsOf(h.calls)).toEqual(['startTake', 'abortTake']);
    expect(h.calls[1].reason).toBe('hook-stopped');
    expect(h.controller.getState()).toBe('idle');
    expect(h.controller.isRunning()).toBe(false);
    expect(h.hook.stopCalls).toBe(1);
    expect(h.hook.listenerCountFor('keydown')).toBe(0);
    expect(h.hook.listenerCountFor('error')).toBe(0);
    expect(h.watchdogs).toEqual([]);
  });

  it('cancels the take when the hook reports that it stopped', () => {
    const h = harness();
    h.controller.start();
    h.hook.press(OPTION_KEYCODE);

    h.hook.emit('stop');

    expect(actionsOf(h.calls)).toEqual(['startTake', 'abortTake']);
    expect(h.calls[1].reason).toBe('hook-stopped');
    expect(h.controller.getState()).toBe('idle');
    expect(h.controller.isRunning()).toBe(false);
  });

  it('stops tracking a hook that fails with no take open', () => {
    const h = harness();
    h.controller.start();

    h.hook.emit('error', new Error('boom'));

    expect(h.calls).toEqual([]);
    expect(h.controller.isRunning()).toBe(false);
    expect(h.controller.getLastOutcome()).toBe('hook-error');
  });

  it('aborts a take when the hook goes silent (lost Option keyup)', () => {
    const h = harness();
    h.controller.start();
    h.hook.press(OPTION_KEYCODE);

    // The only timer in the controller, armed solely for the open take.
    expect(h.watchdogs).toHaveLength(1);
    expect(h.watchdogs[0].ms).toBe(HOOK_SILENCE_TIMEOUT_MS);

    expect(h.fireWatchdog()).toBe(true);

    expect(actionsOf(h.calls)).toEqual(['startTake', 'abortTake']);
    expect(h.calls[1].reason).toBe('hook-stopped');
    expect(h.controller.getState()).toBe('idle');
    // Nothing is left that could fire a second abort later.
    expect(h.fireWatchdog()).toBe(false);
  });

  it('postpones the watchdog on every hook event while the take is open', () => {
    const h = harness();
    h.controller.start();
    h.hook.press(OPTION_KEYCODE);
    expect(h.watchdogs).toHaveLength(1);
    const first = h.watchdogs[0];

    h.hook.emit('input', { type: KEY_PRESSED, keycode: OPTION_KEYCODE });
    expect(h.watchdogs).toHaveLength(1);
    expect(h.watchdogs[0]).not.toBe(first); // re-armed, not merely left alone

    h.clock.value += 2_000;
    h.hook.press(OPTION_KEYCODE); // auto-repeat of the held key: activity only
    expect(h.watchdogs).toHaveLength(1);
    expect(actionsOf(h.calls)).toEqual(['startTake']);
    expect(h.controller.getState()).toBe('recording'); // still counting from re-arm
  });

  it('disarms the watchdog the moment the take ends', () => {
    const h = harness();
    h.controller.start();
    h.hook.press(OPTION_KEYCODE);
    h.clock.value += 500;
    h.hook.release(OPTION_KEYCODE);

    expect(actionsOf(h.calls)).toEqual(['startTake', 'finishTake']);
    expect(h.watchdogs).toEqual([]);
    expect(h.fireWatchdog()).toBe(false); // no late abort can hit a finished take
    expect(h.controller.getState()).toBe('idle');
  });

  it('returns an already-aborted take to idle without a second abort', () => {
    const h = harness();
    h.controller.start();
    h.hook.press(OPTION_KEYCODE);
    h.hook.press(0xe04b); // ArrowLeft: chord abort, recorder already cancelled
    expect(h.controller.getState()).toBe('aborted');
    expect(h.watchdogs).toHaveLength(1); // still waiting for the Option keyup

    expect(h.fireWatchdog()).toBe(true);

    expect(h.controller.getState()).toBe('idle');
    expect(actionsOf(h.calls)).toEqual(['startTake', 'abortTake']);
    expect(h.calls[1].reason).toBe('chord');
  });
});

describe('DictationController: Accessibility trust transition (BLOCKING-1)', () => {
  it('runs the guarded start when trust flips false->true', () => {
    const h = harness({ trusted: false });
    expect(h.controller.start().outcome).toBe('no-accessibility');
    expect(h.hook.startCalls).toBe(0);

    h.options.trusted = true; // the user clicked Allow on the system prompt
    h.controller.reconcileAccessibility(); // the next status read

    expect(h.hook.startCalls).toBe(1);
    expect(h.controller.isRunning()).toBe(true);
    // The guard is the last thing evaluated before hook.start().
    expect(h.options.hookStartOrder[0]).toBe('trust-check');
    expect(h.options.hookStartOrder.slice(-2)).toEqual(['trust-check', 'hook.start']);
    // Every trust check asked without prompting (ask === false).
    expect(h.options.trustChecks.length).toBeGreaterThan(1);
    expect(h.options.trustChecks.every((ask) => ask === false)).toBe(true);
  });

  it('starts on a later poll of an async grant, exactly once', () => {
    const h = harness({ trusted: false });
    h.controller.start();

    // The renderer polls the status every 1.5s while the grant is pending.
    const running: boolean[] = [];
    for (let poll = 0; poll < 4; poll += 1) {
      if (poll === 2) h.options.trusted = true; // grant lands on the 3rd poll
      h.controller.reconcileAccessibility();
      running.push(h.controller.isRunning());
    }

    expect(running).toEqual([false, false, true, true]);
    expect(h.hook.startCalls).toBe(1);
    // Exactly one hook.start(), with the guard immediately before it (a later
    // status read appends its own trust check afterwards).
    const order = h.options.hookStartOrder;
    const startAt = order.lastIndexOf('hook.start');
    expect(order.filter((entry) => entry === 'hook.start')).toHaveLength(1);
    expect(order[startAt - 1]).toBe('trust-check');
  });

  it('keeps the hook stopped while trust never becomes true', () => {
    const h = harness({ trusted: false });
    h.controller.reconcileAccessibility();
    h.controller.reconcileAccessibility();
    expect(h.hook.startCalls).toBe(0);
    expect(h.controller.isRunning()).toBe(false);
  });

  it('does not restart an already-running hook when trust is re-confirmed', () => {
    const h = harness();
    expect(h.controller.start().started).toBe(true);
    h.controller.reconcileAccessibility();
    h.controller.reconcileAccessibility();
    expect(h.hook.startCalls).toBe(1);
    expect(h.hook.listenerCountFor('keydown')).toBe(1);
  });

  it('guards again on every later start path (settings re-enable)', () => {
    const h = harness();
    h.controller.start();
    h.controller.stop();
    expect(h.controller.start().started).toBe(true);
    // One guard immediately before each of the two hook.start() calls.
    expect(h.options.hookStartOrder).toEqual([
      'trust-check',
      'hook.start',
      'trust-check',
      'hook.start',
    ]);
  });
});

describe('notice copy', () => {
  it('uses the exact approved hint strings', () => {
    expect(TOO_SHORT_NOTICE).toBe('Too short - hold the Option key to dictate');
    expect(CHORD_NOTICE).toBe('Dictation cancelled - another key was pressed');
  });
});
