import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEvent }));

beforeEach(() => {
  mocks.logEvent.mockClear();
  process.env.AUNTIE_OPERATOR_UIDS = '';
});

/**
 * `isStaff` was renamed `isOwner` by #944. The behaviour in this first block is
 * unchanged from RULING O-6; only the name moved, because the rules helper
 * `isStaff()` now means "owner OR Auntie" and two boundaries must not share one
 * name in one repository.
 */
describe('isOwner (RULING O-6, Q1: the operator signal, renamed by #944)', () => {
  it('claim-only uid (not on the env allowlist) passes, no deprecation log', async () => {
    const { isOwner } = await import('../src/lib/staffGate');
    expect(isOwner('u1', true, 'testFn')).toBe(true);
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });

  it('env-allowlist-only uid (no claim) passes AND emits the deprecation log', async () => {
    process.env.AUNTIE_OPERATOR_UIDS = 'op1';
    const { isOwner } = await import('../src/lib/staffGate');
    expect(isOwner('op1', false, 'testFn')).toBe(true);
    expect(mocks.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'warn',
        function: 'testFn',
        event: 'admin.allowlist.fallback.used',
        uid: 'op1',
      }),
    );
  });

  it('neither claim nor allowlist fails, no log', async () => {
    const { isOwner } = await import('../src/lib/staffGate');
    expect(isOwner('stranger', false, 'testFn')).toBe(false);
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });

  it('both claim and allowlist: passes, no fallback log (claim already satisfies it)', async () => {
    process.env.AUNTIE_OPERATOR_UIDS = 'op1';
    const { isOwner } = await import('../src/lib/staffGate');
    expect(isOwner('op1', true, 'testFn')).toBe(true);
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });

  it('undefined uid always fails, no log', async () => {
    const { isOwner } = await import('../src/lib/staffGate');
    expect(isOwner(undefined, true, 'testFn')).toBe(false);
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });
});

describe('#944 claim readers', () => {
  it('the operator token today is the owner: admin, no staffRole', async () => {
    const { isOwnerClaim, isAuntieClaim } = await import('../src/lib/staffGate');
    expect(isOwnerClaim({ admin: true })).toBe(true);
    expect(isAuntieClaim({ admin: true })).toBe(false);
  });

  it('an Auntie token is the caretaker and is NOT the owner', async () => {
    const { isOwnerClaim, isAuntieClaim } = await import('../src/lib/staffGate');
    expect(isAuntieClaim({ staffRole: 'auntie' })).toBe(true);
    expect(isOwnerClaim({ staffRole: 'auntie' })).toBe(false);
  });

  /**
   * The account that should not exist. `grant-staff-role.mjs` refuses to mint
   * both claims; if one is minted by hand it must fail toward LESS access, and
   * it must agree with `firestore.rules:isOwner()`, which says the same thing.
   */
  it('a token holding BOTH claims is the caretaker, not the owner', async () => {
    const { isOwnerClaim, isAuntieClaim } = await import('../src/lib/staffGate');
    expect(isOwnerClaim({ admin: true, staffRole: 'auntie' })).toBe(false);
    expect(isAuntieClaim({ admin: true, staffRole: 'auntie' })).toBe(true);
  });

  it('an unrecognised staffRole is neither role', async () => {
    const { isOwnerClaim, isAuntieClaim } = await import('../src/lib/staffGate');
    expect(isOwnerClaim({ staffRole: 'bookkeeper' })).toBe(false);
    expect(isAuntieClaim({ staffRole: 'bookkeeper' })).toBe(false);
  });

  it('a kinfolk token is neither role', async () => {
    const { isOwnerClaim, isAuntieClaim } = await import('../src/lib/staffGate');
    const kinfolk = { role: 'kinfolk', kinfolkId: 'k1' };
    expect(isOwnerClaim(kinfolk)).toBe(false);
    expect(isAuntieClaim(kinfolk)).toBe(false);
  });

  it('an undefined token is neither role', async () => {
    const { isOwnerClaim, isAuntieClaim } = await import('../src/lib/staffGate');
    expect(isOwnerClaim(undefined)).toBe(false);
    expect(isAuntieClaim(undefined)).toBe(false);
  });
});

describe('#944 staffBypass: the per-callable gate', () => {
  const owner = { uid: 'owner-1', token: { admin: true } };
  const auntie = { uid: 'auntie-1', token: { staffRole: 'auntie' } };

  it('the owner passes every callable, allowlisted or not', async () => {
    const { staffBypass } = await import('../src/lib/staffGate');
    expect(staffBypass(owner, 'markInvoicePaid')).toBe(true);
    expect(staffBypass(owner, 'listMembers')).toBe(true);
    expect(staffBypass(owner, 'a-callable-that-does-not-exist')).toBe(true);
  });

  it('an Auntie passes an allowlisted callable', async () => {
    const { staffBypass } = await import('../src/lib/staffGate');
    expect(staffBypass(auntie, 'listMembers')).toBe(true);
    expect(staffBypass(auntie, 'createKinCareSession')).toBe(true);
    expect(staffBypass(auntie, 'addBookingNote')).toBe(true);
  });

  it('an Auntie is refused a money callable, and the refusal is logged', async () => {
    const { staffBypass } = await import('../src/lib/staffGate');
    expect(staffBypass(auntie, 'markInvoicePaid')).toBe(false);
    expect(mocks.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'auntie.callable.refused', uid: 'auntie-1' }),
    );
  });

  /**
   * ABSENT MEANS REFUSED. This is the property that makes one table safe as the
   * whole server boundary: a callable nobody classified, or a name someone
   * mistyped, denies rather than granting the wrong thing.
   */
  it('an Auntie is refused a callable nobody has classified', async () => {
    const { staffBypass } = await import('../src/lib/staffGate');
    expect(staffBypass(auntie, 'someCallableAddedNextMonth')).toBe(false);
    expect(staffBypass(auntie, 'listMember')).toBe(false); // a typo grants nothing
  });

  it('an unauthenticated caller is refused', async () => {
    const { staffBypass } = await import('../src/lib/staffGate');
    expect(staffBypass(undefined, 'listMembers')).toBe(false);
    expect(staffBypass({ token: { staffRole: 'auntie' } }, 'listMembers')).toBe(false);
  });

  it('a kinfolk gets no staff bypass on an allowlisted callable', async () => {
    const { staffBypass } = await import('../src/lib/staffGate');
    expect(staffBypass({ uid: 'u-kin', token: { role: 'kinfolk', kinfolkId: 'k1' } }, 'listMembers')).toBe(false);
  });
});
