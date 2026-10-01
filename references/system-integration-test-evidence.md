# Test Evidence for System-Integration Features

Rules for designing Tester handoffs and acceptance evidence when the feature crosses the OS boundary: global hotkeys, paste-at-cursor, permission-gated capture, live streaming. Plain unit/CDP tests cannot carry these claims alone; this file defines what counts as proof.

## Procedure

1. **Classify each claim by what could falsify it.** For every acceptance criterion, name the smallest event that would make it false — then check your test can actually produce that event. A claim like "system-wide" is falsified by another app being focused during a failed paste; if no step focuses another app, the test cannot falsify the claim and proves nothing about it.

2. **Reject same-library round trips as proof of an external path.** If the test injects an event with library X and the app receives it through library X, the run proves only the internal loop, not the external contract (physical HID input, OS focus routing, per-app delivery). Label such evidence `synthetic` in the report and pair it with either a real-input step or an explicit disclosure that the physical path is unproven.

3. **Gate permission-flow claims on a real state transition.** A forced/simulated denial proves the error branch; only a real `tccutil reset` + human grant + successful start proves the grant flow. Reset state to force the real path when the claim is about post-grant behavior, and hand the human a checklist (below) for the click-through.

4. **Match exact expected outputs and report attempt counts.** Use a precise matcher (exact string, ordered event sequence) rather than a loose one (`/hello/i`, substring). Never retry-until-pass silently: report `PASS on attempt N of M` and fail the criterion if pass requires more attempts than declared. Loose matchers plus undisclosed retries convert flakiness into false determinism.

5. **Test both sides of every threshold, and verify platform assumptions behind timeouts.** For any duration/size boundary (minimum hold, max length), probe just under and just over it. Before shipping a watchdog or idle timeout, verify the platform actually delivers the events the design counts on — do not assume auto-repeat, keepalive, or heartbeat events exist during a healthy idle state; a silence watchdog built on an assumed repeat event will abort healthy long operations.

6. **Split acoustic/content assertions from state-machine assertions.** A silence or no-op run should still deterministically prove start/append/abort sequencing; transcript quality is a separate criterion against a known fixture. Mixing them makes a codec variance look like a state-machine failure and vice versa.

7. **When automation cannot reach the path, write a hands-on checklist.** Numbered steps, each with the exact human action and the exact observable outcome, plus expected app state before/after. Scope it to what only a human can do (physical key holds, clicking real TCC dialogs, focusing another app); everything automatable stays automated. Collect the results back as stage evidence — an unrun checklist is not evidence.

## Pitfalls

- Do not let retries hide nondeterminism — a harness that reruns until green will pass a feature that fails for the user on first try.
- Do not treat a state-machine PASS as an end-to-end PASS when the input was synthetic; scope the claim to what the event source actually exercised.
- Do not ship a timeout whose premise ("the OS will emit events while idle") is unverified — verify with a real long-run probe during build, not by reasoning.
- Label every evidence line as `real` / `synthetic` / `simulated-permission` in reports so the Reviewer and the human can see which claims rest on untested ground.
