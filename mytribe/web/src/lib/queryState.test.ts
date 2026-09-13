import { describe, expect, it } from 'vitest';
import {
  countLabel,
  countOfQuery,
  isOfflinePaused,
  viewOfQuery,
  type QuerySnapshot,
} from './queryState';

/**
 * The decision table, enumerated. These are object literals rather than a live
 * QueryClient on purpose: the pairing of `status` and `fetchStatus` IS the
 * thing under test, and spelling every pair out is cheaper and more legible
 * here than driving a cache into each one. The screen specs
 * (Schedule.test.tsx, Home.test.tsx) drive the real
 * onlineManager and prove the wiring.
 */

function snap<T>(status: QuerySnapshot<T>['status'], fetchStatus: QuerySnapshot<T>['fetchStatus'], data?: T): QuerySnapshot<T> {
  return { status, fetchStatus, data } as QuerySnapshot<T>;
}

describe('viewOfQuery', () => {
  it('pending + paused is offline, NOT empty, the whole defect', () => {
    expect(viewOfQuery(snap<string[]>('pending', 'paused'), { isEmpty: (d) => d.length === 0 })).toEqual({
      kind: 'offline',
    });
  });

  it('pending + fetching is loading', () => {
    expect(viewOfQuery(snap<string[]>('pending', 'fetching'))).toEqual({ kind: 'loading' });
  });

  it('pending + idle with no gate is idle, not loading', () => {
    // A query held behind `enabled: false` is not loading, and a screen that
    // renders a spinner for it spins forever (TribePicker with no tribes).
    expect(viewOfQuery(snap<string[]>('pending', 'idle'))).toEqual({ kind: 'idle' });
  });

  it('error is error', () => {
    expect(viewOfQuery(snap<string[]>('error', 'idle'))).toEqual({ kind: 'error' });
  });

  it('success with rows is data', () => {
    expect(viewOfQuery(snap('success', 'idle', ['a']), { isEmpty: (d) => d.length === 0 })).toEqual({
      kind: 'data',
      data: ['a'],
    });
  });

  it('success with nothing is empty, the ONLY way to reach the empty state', () => {
    expect(viewOfQuery(snap<string[]>('success', 'idle', []), { isEmpty: (d) => d.length === 0 })).toEqual({
      kind: 'empty',
    });
  });

  it('success with no isEmpty never reports empty', () => {
    expect(viewOfQuery(snap<string[]>('success', 'idle', []))).toEqual({ kind: 'data', data: [] });
  });

  it('a paused refetch over cached rows still shows the rows', () => {
    // Signal drops on a screen that already painted. Stale rows beat a blank.
    expect(viewOfQuery(snap('success', 'paused', ['a']), { isEmpty: (d) => d.length === 0 })).toEqual({
      kind: 'data',
      data: ['a'],
    });
  });

  it('an error that then pauses still reads as an error', () => {
    // The server answered badly. Relabelling that "you're offline" would be the
    // same class of lie as calling a paused read empty.
    expect(viewOfQuery(snap<string[]>('error', 'paused'))).toEqual({ kind: 'error' });
  });
});

describe('viewOfQuery gate', () => {
  const gated = snap<string[]>('pending', 'idle');

  it('a query gated behind a paused query is offline', () => {
    // Home: three sections are `enabled: home.isSuccess`. When home pauses they
    // never start, so they sit at pending/idle and used to render empty.
    expect(viewOfQuery(gated, { gate: snap('pending', 'paused'), isEmpty: (d) => d.length === 0 })).toEqual({
      kind: 'offline',
    });
  });

  it('a query gated behind a failed query is an error', () => {
    expect(viewOfQuery(gated, { gate: snap('error', 'idle') })).toEqual({ kind: 'error' });
  });

  it('a query gated behind a loading query is loading', () => {
    expect(viewOfQuery(gated, { gate: snap('pending', 'fetching') })).toEqual({ kind: 'loading' });
  });

  it('the gate is ignored once this query is answering for itself', () => {
    expect(viewOfQuery(snap('success', 'idle', ['a']), { gate: snap('pending', 'paused') })).toEqual({
      kind: 'data',
      data: ['a'],
    });
    expect(viewOfQuery(snap<string[]>('pending', 'paused'), { gate: snap('success', 'idle', 1) })).toEqual({
      kind: 'offline',
    });
  });
});

describe('countOfQuery', () => {
  it('refuses to render a number it does not have', () => {
    expect(countOfQuery(snap<string[]>('pending', 'paused'), (d) => d.length)).toEqual({ kind: 'offline' });
    expect(countOfQuery(snap<string[]>('error', 'idle'), (d) => d.length)).toEqual({ kind: 'error' });
  });

  it('a real zero is still a zero', () => {
    expect(countOfQuery(snap<string[]>('success', 'idle', []), (d) => d.length)).toEqual({ kind: 'value', value: 0 });
  });
});

describe('countLabel', () => {
  it('never prints 0 for an unknown count, and says why out loud', () => {
    expect(countLabel({ kind: 'offline' })).toEqual({ text: '?', hint: 'Not known while you are offline' });
    expect(countLabel({ kind: 'error' })).toEqual({ text: '?', hint: "This didn't load" });
    expect(countLabel({ kind: 'loading' })).toEqual({ text: '…', hint: 'Still loading' });
    expect(countLabel({ kind: 'value', value: 0 })).toEqual({ text: '0', hint: null });
  });
});

describe('isOfflinePaused', () => {
  it('is true only for a paused read', () => {
    expect(isOfflinePaused(snap('pending', 'paused'))).toBe(true);
    expect(isOfflinePaused(snap('pending', 'fetching'))).toBe(false);
    expect(isOfflinePaused(snap('success', 'idle', 1))).toBe(false);
    expect(isOfflinePaused(snap('pending', 'idle'), snap('pending', 'paused'))).toBe(true);
  });
});
