import { describe, expect, it, vi } from 'vitest';
import { asyncScalar, resolveAsync, type Async } from './async';

/**
 * The load-state primitive exists because of what the wasm admin does today.
 *
 * Live evidence, 2026-07-15, driving production:
 *   - Home:         "Open bookings: 0 / needs a reply" while the read was
 *                   permission-denied. Nothing on the screen said so.
 *   - Bookings:     two red "Couldn't load" banners sitting beside three counts
 *                   that all said 0.
 *   - Tribal Intel: "Couldn't load training documents" stacked directly on top of
 *                   "No Tribal Intel yet: ... will appear here once uploaded".
 *   - Templates:    error banner + stat cards spinning "..." forever + "Loading
 *                   templates..." that never ends + "All 0". Three states at once.
 *
 * Every one is the same shape: `(state as? Data)?.value ?: emptyList()` collapses
 * an Error into an empty success, and then an independent `if (isEmpty)` renders a
 * cheerful empty state on top of a failure.
 *
 * So the rule this module enforces is not "please remember to handle errors". It
 * is that error / loading / empty / ready are MUTUALLY EXCLUSIVE and the caller
 * cannot reach the empty branch while the load is failing. Form Schemas already
 * proves the target (names the failing callable, offers Retry, and says "Schemas
 * unavailable while the load is failing" rather than claiming zero); this makes
 * that the only easy thing to write.
 */

const READY: Async<number[]> = { status: 'ready', data: [1, 2, 3] };
const EMPTY: Async<number[]> = { status: 'ready', data: [] };
const LOADING: Async<number[]> = { status: 'loading' };
const FAILED: Async<number[]> = { status: 'error', message: 'Missing or insufficient permissions.' };

describe('resolveAsync: exactly one branch, always', () => {
  const isEmpty = (d: number[]) => d.length === 0;

  it('ready with data resolves to data', () => {
    expect(resolveAsync(READY, isEmpty)).toEqual({ kind: 'data', data: [1, 2, 3] });
  });

  it('ready with nothing in it resolves to empty', () => {
    expect(resolveAsync(EMPTY, isEmpty)).toEqual({ kind: 'empty' });
  });

  it('loading resolves to loading, never to empty', () => {
    // Templates renders "Loading templates..." AND "All 0" simultaneously today.
    expect(resolveAsync(LOADING, isEmpty)).toEqual({ kind: 'loading' });
  });

  it('error resolves to error', () => {
    expect(resolveAsync(FAILED, isEmpty)).toEqual({
      kind: 'error',
      message: 'Missing or insufficient permissions.',
    });
  });

  it('THE BUG: an error never resolves to empty, however empty it looks', () => {
    // This is Tribal Intel. The read failed; the list is therefore unknown, NOT
    // zero. `isEmpty` must not even be consulted, so a caller cannot smuggle a
    // false empty state in through a predicate that says "no data means empty".
    const alwaysEmpty = vi.fn().mockReturnValue(true);
    const r = resolveAsync(FAILED, alwaysEmpty);

    expect(r.kind).toBe('error');
    expect(alwaysEmpty, 'isEmpty must not run while the load is failing').not.toHaveBeenCalled();
  });

  it('carries retry through so the error branch can offer recovery', () => {
    const retry = vi.fn();
    const r = resolveAsync({ status: 'error', message: 'boom', retry }, isEmpty);
    expect(r.kind).toBe('error');
    if (r.kind === 'error') {
      r.retry?.();
      expect(retry).toHaveBeenCalledOnce();
    }
  });
});

describe('asyncScalar: a count must never be a lie', () => {
  // The Home/Bookings defect. `openBookings` was
  // `(state as? Data)?.value?.size ?: 0`, so Error became 0 and the card printed
  // it. A number on screen is a claim; we only make it when we can prove it.
  const count = (d: number[]) => d.length;

  it('ready renders the real number', () => {
    expect(asyncScalar(READY, count)).toEqual({ kind: 'value', value: 3 });
  });

  it('a genuine zero still renders zero', () => {
    // Absent data and unreadable data are different answers. This is the one that
    // must survive: an empty inbox is a real, printable fact.
    expect(asyncScalar(EMPTY, count)).toEqual({ kind: 'value', value: 0 });
  });

  it('loading is unknown, not zero', () => {
    expect(asyncScalar(LOADING, count)).toEqual({ kind: 'loading' });
  });

  it('THE BUG: error is unknown, not zero', () => {
    expect(asyncScalar(FAILED, count)).toEqual({
      kind: 'error',
      message: 'Missing or insufficient permissions.',
    });
  });

  it('never runs the projection on a failed load', () => {
    // If the projection ran, it would need data that does not exist, and the
    // only way to supply it is the `?: 0` that caused all of this.
    const project = vi.fn().mockReturnValue(0);
    asyncScalar(FAILED, project);
    expect(project).not.toHaveBeenCalled();
  });
});
