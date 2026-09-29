import { EventEmitter } from 'events';
import {
  CHORD_NOTICE,
  DictationActions,
  DictationController,
  DictationHook,
  DictationKeyEvent,
  DictationTakeReason,
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

  start(): void {
    this.startCalls += 1;
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

  listenerCountFor(event: 'keydown' | 'keyup'): number {
    return this.listenerCount(event);
  }
}

interface RecordedCall {
  action: 'startTake' | 'abortTake' | 'finishTake';
  reason?: DictationTakeReason;
  heldMs?: number;
}

interface Harness {
  hook: FakeHook;
  controller: DictationController;
  calls: RecordedCall[];
  clock: { value: number };
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
  const options = {
    enabled: overrides.enabled ?? true,
    trusted: overrides.trusted ?? true,
    canStart: overrides.canStart ?? true,
    trustChecks: [] as boolean[],
    hookStartOrder: [] as string[],
  };

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
  });

  return { hook, controller, calls, clock, options };
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

describe('notice copy', () => {
  it('uses the exact approved hint strings', () => {
    expect(TOO_SHORT_NOTICE).toBe('Too short - hold the Option key to dictate');
    expect(CHORD_NOTICE).toBe('Dictation cancelled - another key was pressed');
  });
});
