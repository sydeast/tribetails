/**
 * Step arithmetic for `components/WizardModal`, kept out of the component so
 * every transition is unit-testable without mounting a modal.
 *
 * WHAT THIS IS NOT: `lib/bookingWizard.ts`. That file is the New Booking
 * wizard's own state machine, and its `stepBlocker`/`firstBlockedStep`/
 * `reachable` shape encodes a booking rule — you cannot pick dates before you
 * have picked a household, so a later step is not reachable until an earlier one
 * is satisfied. An EDITOR has no such dependency: the sections of a form schema
 * do not depend on each other, and an operator fixing one field must not have to
 * walk four screens to reach it. So every step here is always directly
 * navigable, and a problem on a step is REPORTED (on the rail, and on the step)
 * rather than used to lock the operator out of the rest of the form.
 *
 * Steps are DATA, passed on every render, not registered once. That is what lets
 * a caller whose sections switch on and off (the KinTale template editor's
 * `checklistEnabled` / `petMoodEnabled` toggles) express itself as a filtered
 * array, and it is why `resolveStepKey` exists: the step under the operator's
 * feet can disappear, and landing somewhere sensible beats rendering nothing.
 */

export interface WizardStepState {
  /** Stable identity. Survives a label change and is what navigation is expressed in. */
  key: string;
  /** The rail's short name for this step. */
  label: string;
  /** Everything the operator has to fix on this step. Empty means clean. */
  errors: readonly string[];
}

export interface StepPosition {
  /** 0-based, or -1 when the list does not carry the key. */
  index: number;
  /** 1-based, for "Step 2 of 3". 0 when the key is not carried. */
  number: number;
  total: number;
}

export function stepPosition(steps: readonly WizardStepState[], key: string): StepPosition {
  const index = steps.findIndex((s) => s.key === key);
  return { index, number: index === -1 ? 0 : index + 1, total: steps.length };
}

/**
 * The step to actually render, given the key the caller believes it is on.
 *
 * Normally that key, unchanged. When the key is GONE — the caller turned off the
 * toggle that owned it — this falls back to whatever step now occupies the index
 * it used to hold, clamped to the end of the list. Falling back positionally
 * rather than to step 1 keeps the operator where they were working: switching
 * "Kin mood" off while standing on the Moods step should land on the step that
 * followed it, not throw them back to the top of the form.
 *
 * Null only when there are no steps at all, which the component renders as an
 * empty body rather than crashing.
 */
export function resolveStepKey(
  steps: readonly WizardStepState[],
  key: string,
  priorIndex: number,
): string | null {
  if (steps.length === 0) return null;
  const found = steps.find((s) => s.key === key);
  if (found) return found.key;
  const clamped = Math.min(Math.max(priorIndex, 0), steps.length - 1);
  return steps[clamped]!.key;
}

/** The next step, or null at the end (and from a key the list does not carry). */
export function nextStepKey(steps: readonly WizardStepState[], key: string): string | null {
  const { index } = stepPosition(steps, key);
  if (index === -1 || index >= steps.length - 1) return null;
  return steps[index + 1]!.key;
}

/** The previous step, or null at the start (and from a key the list does not carry). */
export function prevStepKey(steps: readonly WizardStepState[], key: string): string | null {
  const { index } = stepPosition(steps, key);
  if (index <= 0) return null;
  return steps[index - 1]!.key;
}

/**
 * The earliest step with something to fix, walked from the START rather than
 * from wherever the operator is standing. A failed finish jumps here, so it has
 * to name the first problem in reading order, not the next one.
 */
export function firstStepWithErrors(steps: readonly WizardStepState[]): string | null {
  return steps.find((s) => s.errors.length > 0)?.key ?? null;
}

/** Every problem across every step, for the one-line summary next to the finish button. */
export function errorTotal(steps: readonly WizardStepState[]): number {
  return steps.reduce((sum, s) => sum + s.errors.length, 0);
}
