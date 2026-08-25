import { FirebaseError } from 'firebase/app';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The callable choke point's error mapping.
 *
 * The `functions/internal` branch is the half that matters and the half that is
 * easiest to lose in a refactor. `internal` is what the SDK reports for ANY
 * transport failure (`postJSON` swallows the fetch rejection and returns
 * `status: 0`), so it means two completely different things depending on where
 * the SDK is pointed. In production it is a real backend fault and must reach
 * the operator as one. In an e2e run the SDK is pinned at `127.0.0.1:5399` with
 * nothing listening, so it can only be an unstubbed callable, and reporting that
 * as a backend fault is how the harness came to report green while its callables
 * were being answered by production.
 *
 * Both directions are asserted, because a mapping that fires everywhere is as
 * wrong as one that fires nowhere: it would relabel genuine production outages
 * as a test-harness problem.
 */

const { httpsCallable } = vi.hoisted(() => ({ httpsCallable: vi.fn() }));
vi.mock('firebase/functions', () => ({ httpsCallable }));

/** `emulatorHost` is reassigned per test; the mock reads it at call time. */
let emulatorHost = '';
vi.mock('./firebase', () => ({
  functions: {},
  get E2E_EMULATOR_HOST() {
    return emulatorHost;
  },
  E2E_FUNCTIONS_PORT: 5399,
}));

/**
 * #573: the revocation reaction is mocked rather than exercised end-to-end here.
 * `revokedSession.test.ts` owns what it DOES; this file owns whether `call()`
 * routes to it at all, which is the wiring a refactor can silently drop.
 */
const { noteSessionAlive, reactToCallableError } = vi.hoisted(() => ({
  noteSessionAlive: vi.fn(),
  reactToCallableError: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./revokedSession', () => ({ noteSessionAlive, reactToCallableError }));

const { call, CallableNotStubbedError, CallableTimeoutError } = await import('./fns');

/** Makes the next `call()` reject with [code], as the SDK would. */
function rejectWith(code: string): void {
  httpsCallable.mockReturnValue(() =>
    Promise.reject(new FirebaseError(code, code.replace('functions/', ''))),
  );
}

beforeEach(() => {
  emulatorHost = '';
  httpsCallable.mockReset();
  noteSessionAlive.mockClear();
  reactToCallableError.mockClear();
});

describe('call', () => {
  it('returns the callable payload unwrapped from the SDK envelope', async () => {
    httpsCallable.mockReturnValue(() => Promise.resolve({ data: { lowCount: 2 } }));
    await expect(call('listSupplies', {})).resolves.toEqual({ lowCount: 2 });
  });

  it('maps a deadline to CallableTimeoutError, in production and in the harness alike', async () => {
    rejectWith('functions/deadline-exceeded');
    await expect(call('listSupplies', {})).rejects.toBeInstanceOf(CallableTimeoutError);

    emulatorHost = '127.0.0.1';
    rejectWith('functions/deadline-exceeded');
    await expect(call('listSupplies', {})).rejects.toBeInstanceOf(CallableTimeoutError);
  });

  it('leaves functions/internal alone outside emulator mode, because there it is a real outage', async () => {
    rejectWith('functions/internal');
    const err = await call('listSupplies', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FirebaseError);
    expect(err).not.toBeInstanceOf(CallableNotStubbedError);
  });

  it('maps functions/internal to a named, actionable error in emulator mode', async () => {
    emulatorHost = '127.0.0.1';
    rejectWith('functions/internal');
    const err = await call('listSupplies', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CallableNotStubbedError);
    // The message has to carry all three, or it sends the reader to the wrong
    // layer: WHICH callable, WHERE it was dialling, and that this is the harness
    // refusing rather than a backend failing.
    expect((err as Error).message).toContain('listSupplies');
    expect((err as Error).message).toContain('127.0.0.1:5399');
    expect((err as Error).message).toContain('never reach production callables');
  });

  it('does not swallow other callable errors in emulator mode', async () => {
    emulatorHost = '127.0.0.1';
    rejectWith('functions/permission-denied');
    const err = await call('listSupplies', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FirebaseError);
    expect((err as FirebaseError).code).toBe('functions/permission-denied');
  });
});

/**
 * #573. `call()` is the one place every admin callable passes through, which is
 * why the revocation reaction is installed here and not in the ~200 api/ call
 * sites. These assert the two halves of that seam: every failure is offered to
 * the classifier, and every success re-arms it.
 */
describe('call, revoked-session reaction', () => {
  it('offers a failed callable to the classifier, then rethrows unchanged', async () => {
    rejectWith('functions/unauthenticated');
    const err = await call('listSupplies', {}).catch((e: unknown) => e);
    expect(reactToCallableError).toHaveBeenCalledTimes(1);
    // Rethrown, not consumed: a screen that was going to show a banner still does.
    expect(err).toBeInstanceOf(FirebaseError);
    expect((err as FirebaseError).code).toBe('functions/unauthenticated');
  });

  it('awaits the reaction before the caller sees the rejection', async () => {
    // The sign-out has to be under way before a screen paints its own error, or
    // the operator gets a red banner on a screen that is about to disappear.
    let reacted = false;
    reactToCallableError.mockImplementationOnce(async () => {
      await Promise.resolve();
      reacted = true;
    });
    rejectWith('functions/unauthenticated');
    await call('listSupplies', {}).catch(() => undefined);
    expect(reacted).toBe(true);
  });

  it('re-arms the teardown guard on every success', async () => {
    httpsCallable.mockReturnValue(() => Promise.resolve({ data: {} }));
    await call('listSupplies', {});
    expect(noteSessionAlive).toHaveBeenCalledTimes(1);
    expect(reactToCallableError).not.toHaveBeenCalled();
  });

  it('does not offer a deadline to the classifier — a timeout says nothing about the session', async () => {
    rejectWith('functions/deadline-exceeded');
    await expect(call('listSupplies', {})).rejects.toBeInstanceOf(CallableTimeoutError);
    expect(reactToCallableError).not.toHaveBeenCalled();
  });

  it('does not offer an unstubbed-callable harness error to the classifier either', async () => {
    emulatorHost = '127.0.0.1';
    rejectWith('functions/internal');
    await expect(call('listSupplies', {})).rejects.toBeInstanceOf(CallableNotStubbedError);
    expect(reactToCallableError).not.toHaveBeenCalled();
  });
});
