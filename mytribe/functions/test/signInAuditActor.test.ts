import { describe, it, expect, vi } from 'vitest';

/**
 * #944 / #948 follow-up: the sign-in audit row must name an Auntie correctly.
 *
 * `beforeSignIn` derived the row's `actorRole` from the `admin` claim alone,
 * and an Auntie carries no `admin` claim ON PURPOSE — that is the whole safety
 * property of the claim split. So her sign-in was written to the audit log as
 * `PRIMARY`, the HOUSEHOLD label. The audit log is how the operator sees who
 * did what, and the single row that says a contractor was on the system at all
 * pointed at the wrong kind of account.
 *
 * WHY THIS TESTS A PURE FUNCTION RATHER THAN THE BLOCKING FUNCTION.
 * `beforeSignIn` is a `beforeUserSignedIn` handler: it is not a callable, it
 * has no dispatcher to drive, and reaching its audit emit means walking a lock
 * check, a reset detection and a Firestore write first. The labelling is the
 * thing under test, so it was extracted to `signInAuditActor` and is exercised
 * where it is decided. The emit itself is three lines of field passing, read
 * directly above the function in loginSecurity.ts.
 *
 * `lib/firestoreAdmin` IS MOCKED, like the other 280 test files here, and that
 * is not boilerplate: importing loginSecurity.ts for real opens a Firestore
 * client, and #948 shipped a test that did exactly that and picked up the
 * quota project out of this machine's ambient gcloud credentials. It passed
 * locally and failed in CI. Verified again here with CLOUDSDK_CONFIG pointed at
 * an empty directory.
 */
vi.mock('../src/lib/firestoreAdmin', () => ({
  db: vi.fn(),
  auth: vi.fn(),
  getAdmin: vi.fn(),
}));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn(async () => 'audit-1') }));
vi.mock('../src/lib/sentry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/sentry')>();
  return { ...actual, initSentry: vi.fn(), captureFunctionError: vi.fn() };
});

import { signInAuditActor } from '../src/auth/loginSecurity';

describe('signInAuditActor', () => {
  it('labels an AUNTIE as staff, and NAMES her, rather than as a household PRIMARY', () => {
    // The defect. Before this, `staffRole: 'auntie'` with no `admin` claim fell
    // through to PRIMARY.
    const actor = signInAuditActor({ staffRole: 'auntie' });
    expect(actor.actorRole).toBe('AUNTIE');
    expect(actor.actorRole).not.toBe('PRIMARY');
    expect(actor.descriptionSuffix).toBe(' (auntie)');
    expect(actor.staffRole).toBe('auntie');
    // She holds no owner claim, and the row says so rather than rounding her up
    // to the owner because she landed in the same band.
    expect(actor.admin).toBe(false);
  });

  it('the owner is unchanged: AUNTIE band, "(admin)", admin true', () => {
    // The no-regression half. Every AUTH_LOGIN_SUCCESS row already in Firestore
    // was written by this branch, and it must keep writing the same shape.
    const actor = signInAuditActor({ admin: true });
    expect(actor.actorRole).toBe('AUNTIE');
    expect(actor.descriptionSuffix).toBe(' (admin)');
    expect(actor.admin).toBe(true);
    expect(actor.staffRole).toBeNull();
  });

  it('the legacy `role: "admin"` operator signal still reads as the owner', () => {
    const actor = signInAuditActor({ role: 'admin' });
    expect(actor.actorRole).toBe('AUNTIE');
    expect(actor.descriptionSuffix).toBe(' (admin)');
    expect(actor.admin).toBe(true);
  });

  it('a household member is still PRIMARY', () => {
    const actor = signInAuditActor({ role: 'kinfolk', kinfolkId: 'kf_9' });
    expect(actor.actorRole).toBe('PRIMARY');
    expect(actor.descriptionSuffix).toBe('');
    expect(actor.admin).toBe(false);
    expect(actor.staffRole).toBeNull();
  });

  it('an account with no claims at all is PRIMARY, and so is a missing claims object', () => {
    expect(signInAuditActor({}).actorRole).toBe('PRIMARY');
    expect(signInAuditActor(undefined).actorRole).toBe('PRIMARY');
    expect(signInAuditActor(null).actorRole).toBe('PRIMARY');
  });

  it('a DOUBLE-CLAIMED account is filed as the caretaker, matching the degrade', () => {
    // Every other gate in the split subtracts the caretaker from the owner, so
    // the row must say what the boundary actually did rather than what the
    // `admin` claim would suggest on its own. `admin: true` is still reported,
    // truthfully, which is how this account is findable at all.
    const actor = signInAuditActor({ admin: true, staffRole: 'auntie' });
    expect(actor.actorRole).toBe('AUNTIE');
    expect(actor.descriptionSuffix).toBe(' (auntie)');
    expect(actor.admin).toBe(true);
    expect(actor.staffRole).toBe('auntie');
  });

  it('an unknown future staff role does not borrow the caretaker label', () => {
    // Spec §3: `staffRole: 'bookkeeper'` is neither role. With no owner claim
    // it is a plain account, and the row records the role verbatim so the
    // operator can see an account nobody has written rules for signed in.
    const actor = signInAuditActor({ staffRole: 'bookkeeper' });
    expect(actor.actorRole).toBe('PRIMARY');
    expect(actor.descriptionSuffix).toBe('');
    expect(actor.staffRole).toBe('bookkeeper');
  });

  it('does not coerce a non-true admin claim or a non-string staffRole', () => {
    // Custom claims arrive decoded from a JWT.
    expect(signInAuditActor({ admin: 'true' }).actorRole).toBe('PRIMARY');
    expect(signInAuditActor({ staffRole: 42 }).staffRole).toBeNull();
  });
});
