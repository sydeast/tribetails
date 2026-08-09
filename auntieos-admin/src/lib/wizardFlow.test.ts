import { describe, expect, it } from 'vitest';
import {
  errorTotal,
  firstStepWithErrors,
  nextStepKey,
  prevStepKey,
  resolveStepKey,
  stepPosition,
  type WizardStepState,
} from './wizardFlow';

function step(key: string, errors: string[] = []): WizardStepState {
  return { key, label: key, errors };
}

const THREE = [step('schema'), step('fields'), step('review')];

describe('stepPosition (pure)', () => {
  it('is the 1-based index and the total', () => {
    expect(stepPosition(THREE, 'fields')).toEqual({ index: 1, number: 2, total: 3 });
  });

  it('reports index -1 for a key the list does not carry', () => {
    expect(stepPosition(THREE, 'gone')).toEqual({ index: -1, number: 0, total: 3 });
  });
});

describe('resolveStepKey (pure)', () => {
  it('keeps a key the list still carries', () => {
    expect(resolveStepKey(THREE, 'fields', 0)).toBe('fields');
  });

  /**
   * The KinTale case: a step disappears because the toggle that owned it was
   * switched off while the operator was standing on it.
   */
  it('falls back to the step now sitting at the vanished step index', () => {
    const shrunk = [step('schema'), step('review')];
    expect(resolveStepKey(shrunk, 'fields', 1)).toBe('review');
  });

  it('clamps to the last step when the vanished index is off the end', () => {
    const shrunk = [step('schema')];
    expect(resolveStepKey(shrunk, 'review', 2)).toBe('schema');
  });

  it('is null when there are no steps at all', () => {
    expect(resolveStepKey([], 'schema', 0)).toBeNull();
  });
});

describe('nextStepKey / prevStepKey (pure)', () => {
  it('walks forward and stops at the end', () => {
    expect(nextStepKey(THREE, 'schema')).toBe('fields');
    expect(nextStepKey(THREE, 'review')).toBeNull();
  });

  it('walks back and stops at the start', () => {
    expect(prevStepKey(THREE, 'review')).toBe('fields');
    expect(prevStepKey(THREE, 'schema')).toBeNull();
  });

  it('is null from a key the list does not carry', () => {
    expect(nextStepKey(THREE, 'gone')).toBeNull();
    expect(prevStepKey(THREE, 'gone')).toBeNull();
  });
});

describe('firstStepWithErrors / errorTotal (pure)', () => {
  it('names the earliest step carrying a problem', () => {
    const steps = [step('schema'), step('fields', ['Label is required.']), step('review')];
    expect(firstStepWithErrors(steps)).toBe('fields');
  });

  it('walks from the start, not from the current step', () => {
    const steps = [step('schema', ['Schema id is required.']), step('fields', ['Label is required.'])];
    expect(firstStepWithErrors(steps)).toBe('schema');
  });

  it('is null when every step is clean', () => {
    expect(firstStepWithErrors(THREE)).toBeNull();
  });

  it('counts every problem across every step', () => {
    const steps = [step('schema', ['a', 'b']), step('fields', ['c'])];
    expect(errorTotal(steps)).toBe(3);
    expect(errorTotal(THREE)).toBe(0);
  });
});
