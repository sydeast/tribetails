import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LostSignalError,
  OfflineCallError,
  isConnected,
  phaseOfError,
  queuedWrites,
  resetQueuedWrites,
  settleWrite,
} from './offlineWrite';
import { OfflineSessionError } from './readOnlySession';

/**
 * #807's admin half, as a decision table.
 *
 * The defect is not React Query here — this app has no `useMutation` at all.
 * It is that `setDoc`/`updateDoc`/`addDoc` resolve on SERVER ACK, so offline
 * their promise never settles either way and every `setBusy(true); await …`
 * runs its spinner for as long as the tab is open.
 */

/**
 * `vi.stubGlobal`, not `vi.spyOn(navigator, 'onLine')`: these specs run under
 * the 'node' environment, where the `navigator` global exists (Node 21+) but
 * carries no `onLine` property to spy on at all. Replacing the global is the
 * only way to say "offline" here, and it is also the exact shape `isConnected`
 * has to survive — see its header.
 */
function goOffline(): void {
  vi.stubGlobal('navigator', { onLine: false });
}

beforeEach(() => {
  resetQueuedWrites();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetQueuedWrites();
});

describe('phaseOfError', () => {
  it('separates never-sent from outcome-unknown from a server refusal', () => {
    expect(phaseOfError(new OfflineCallError('recordPayment'))).toBe('blocked');
    expect(phaseOfError(new LostSignalError('recordPayment'))).toBe('unknown');
    expect(phaseOfError(new Error('invoice_already_settled'))).toBe('failed');
  });

  /**
   * The latch. The classes carry the verdict, so a payment whose fate is
   * unknown does not quietly become "it failed, try again" the moment the
   * signal returns — which would be a re-send prompt for a callable that
   * writes an auto-id payment row with no dedupe key.
   */
  it('keeps its verdict after the connection comes back', () => {
    const err = new LostSignalError('recordPayment');
    goOffline();
    expect(phaseOfError(err)).toBe('unknown');
    vi.unstubAllGlobals();
    expect(isConnected()).toBe(true);
    expect(phaseOfError(err)).toBe('unknown');
  });

  /**
   * `RouteError.tsx` already treats `OfflineSessionError` as "offline, not
   * broken". Subclassing rather than inventing a second name is what keeps
   * every existing catch working without being taught anything.
   */
  it('is still an OfflineSessionError, so existing handlers keep working', () => {
    expect(new OfflineCallError('x')).toBeInstanceOf(OfflineSessionError);
  });
});

describe('settleWrite', () => {
  it('awaits normally when there is a connection', async () => {
    const outcome = await settleWrite(Promise.resolve('ack'), 'your settings');
    expect(outcome.queued).toBe(false);
    expect(queuedWrites()).toHaveLength(0);
  });

  /**
   * THE DEFECT, as one assertion. A bare `await setDoc(...)` here would never
   * return, and the button above it would spin forever.
   */
  it('does not wait on a write the device cannot acknowledge', async () => {
    goOffline();
    // The promise Firestore hands back offline: never resolves, never rejects.
    const never = new Promise<void>(() => {});
    const outcome = await settleWrite(never, 'your settings');
    expect(outcome.queued).toBe(true);
  });

  it('names the queued write so one banner can report all of them', async () => {
    goOffline();
    await settleWrite(new Promise<void>(() => {}), 'your settings');
    await settleWrite(new Promise<void>(() => {}), 'a KinTale');
    expect(queuedWrites().map((q) => q.what)).toEqual(['your settings', 'a KinTale']);
  });

  it('drops a queued write off the banner once it settles either way', async () => {
    goOffline();
    let land = (): void => undefined;
    const write = new Promise<void>((resolve) => {
      land = () => resolve();
    });
    await settleWrite(write, 'your settings');
    expect(queuedWrites()).toHaveLength(1);
    land();
    await write;
    await Promise.resolve();
    await Promise.resolve();
    expect(queuedWrites()).toHaveLength(0);
  });

  it('keeps a background write off the banner', async () => {
    goOffline();
    const outcome = await settleWrite(new Promise<void>(() => {}), 'a location fix', { silent: true });
    expect(outcome.queued).toBe(true);
    expect(queuedWrites()).toHaveLength(0);
  });

  /**
   * A write that was already away when the signal went is NOT a write that
   * failed, and must not be reported as one: its outcome is unknown.
   */
  it('relabels a rejection that arrived with no connection', async () => {
    const write = Promise.reject(new Error('unavailable'));
    const settle = settleWrite(write, 'a payment');
    goOffline();
    await expect(settle).rejects.toBeInstanceOf(LostSignalError);
  });

  it('lets a real server refusal through untouched', async () => {
    const refusal = new Error('invoice_already_settled');
    await expect(settleWrite(Promise.reject(refusal), 'a payment')).rejects.toBe(refusal);
  });
});
