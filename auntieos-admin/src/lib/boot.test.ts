// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #576: attestation is decided ONCE per page lifetime, from the first auth state
 * Firebase resolves.
 *
 * These are the assertions that would have caught issue #556 in the portal. The
 * bug there was not that App Check was misconfigured — it was that the guard in
 * front of `activateAppCheck()` asked a question a module-level side effect had
 * already answered, so the guard was permanently true and the call was
 * unreachable on every boot, in every session, while the comments said
 * otherwise. Nothing asserted that activation HAPPENED, so nothing noticed.
 *
 * So the shape of these tests matters as much as their content: they assert the
 * observable outcome (`activateAppCheck` was or was not called, and what
 * `getAppCheckStatus` reports afterwards), never that some internal flag looks
 * right.
 */

const { activateAppCheck, getAppCheckStatus } = vi.hoisted(() => ({
  activateAppCheck: vi.fn(),
  getAppCheckStatus: vi.fn(() => 'inactive' as string),
}));
vi.mock('./firebase', () => ({ activateAppCheck, getAppCheckStatus }));

import {
  attestationDecided,
  attestationOwnsRecaptcha,
  decideAttestation,
  resetAttestationDecisionForTest,
} from './boot';

beforeEach(() => {
  resetAttestationDecisionForTest();
  activateAppCheck.mockClear();
  getAppCheckStatus.mockReturnValue('inactive');
});

describe('decideAttestation', () => {
  it('activates App Check for a lifetime that boots signed in', () => {
    expect(attestationDecided()).toBe(false);
    decideAttestation(true);
    expect(activateAppCheck).toHaveBeenCalledTimes(1);
    expect(attestationDecided()).toBe(true);
  });

  it('leaves App Check alone for a lifetime that boots signed out', () => {
    // That lifetime's job is sign-in, and the auth reCAPTCHA loader has to be
    // the one that owns `grecaptcha` there.
    decideAttestation(false);
    expect(activateAppCheck).not.toHaveBeenCalled();
    expect(attestationDecided()).toBe(true);
  });

  it('does not activate on a sign-in that happens later in the same lifetime', () => {
    decideAttestation(false);
    decideAttestation(true);
    decideAttestation(true);
    // The whole point of the latch: a second Enterprise loader in one document
    // is the collision, and "we signed in, so attest now" is exactly how it
    // would be introduced by someone reading only the happy path.
    expect(activateAppCheck).not.toHaveBeenCalled();
  });

  it('activates exactly once when the listener fires again with the same state', () => {
    decideAttestation(true);
    decideAttestation(true);
    expect(activateAppCheck).toHaveBeenCalledTimes(1);
  });
});

describe('attestationOwnsRecaptcha', () => {
  it('is true while a token is in flight and once one has arrived', () => {
    getAppCheckStatus.mockReturnValue('pending');
    expect(attestationOwnsRecaptcha()).toBe(true);
    getAppCheckStatus.mockReturnValue('active');
    expect(attestationOwnsRecaptcha()).toBe(true);
  });

  it('is false for every state that never loaded the script', () => {
    // `failed` is the interesting one. Activation can fail before the script
    // ever loads (initializeAppCheck throwing), and treating a failure as
    // ownership would cost an operator a page reload for nothing.
    for (const status of ['inactive', 'unconfigured', 'unsupported', 'failed']) {
      getAppCheckStatus.mockReturnValue(status);
      expect(attestationOwnsRecaptcha()).toBe(false);
    }
  });
});
