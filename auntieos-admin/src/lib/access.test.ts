import { describe, it, expect } from 'vitest';
import { accessFromClaims } from './access';

describe('accessFromClaims, the admin gate', () => {
  it('admits a real admin', () => {
    expect(accessFromClaims({ admin: true })).toEqual({ status: 'admin' });
  });

  it('admits a Stage 0I test admin, scoped to its testTribeId', () => {
    expect(accessFromClaims({ testTribeId: 'test-kinfolk-001' })).toEqual({
      status: 'testAdmin',
      testTribeId: 'test-kinfolk-001',
    });
  });

  it('prefers admin when a user somehow carries both', () => {
    expect(accessFromClaims({ admin: true, testTribeId: 'test-kinfolk-001' })).toEqual({
      status: 'admin',
    });
  });

  it('DENIES a plain kinfolk (portal creds) with no admin/test claim', () => {
    expect(accessFromClaims({ role: 'kinfolk', kinfolkId: 'k1' })).toEqual({ status: 'denied' });
    expect(accessFromClaims({})).toEqual({ status: 'denied' });
  });

  it('treats a non-true admin claim and a blank testTribeId as denied (no coercion)', () => {
    expect(accessFromClaims({ admin: 'true' })).toEqual({ status: 'denied' });
    expect(accessFromClaims({ admin: false, testTribeId: '   ' })).toEqual({ status: 'denied' });
  });
});

/**
 * #944, the first of the two blockers this PR closes. Before it, an account
 * minted with `staffRole: 'auntie'` authenticated and landed on `denied`: the
 * server boundary was live and nobody could reach it.
 *
 * Spec: docs/superpowers/specs/2026-09-22-admin-auntie-access-design.md §3, §11.
 */
describe('accessFromClaims, the caretaker', () => {
  it('admits an Auntie, who carries staffRole and NO admin claim', () => {
    expect(accessFromClaims({ staffRole: 'auntie' })).toEqual({ status: 'caretaker' });
  });

  it('does NOT admit her as the owner', () => {
    // The property the whole claim split exists to protect: an unrevisited site
    // reading `admin === true` must refuse her. If this ever reads 'admin', the
    // 116 rule sites and 62 server expressions #948 did not have to edit all
    // silently start granting a contractor owner power.
    expect(accessFromClaims({ staffRole: 'auntie' })).not.toEqual({ status: 'admin' });
  });

  it('DEGRADES a double-claimed account to the caretaker, never the owner', () => {
    // `grant-staff-role.mjs` refuses to mint this, and as of this PR so does
    // `setAdminClaim` in the second functions codebase. If one is made by hand
    // anyway, the client must land on the same boundary the server puts it on:
    // `firestore.rules:isOwner()` and `lib/staffGate.ts:isOwnerClaim()` both
    // subtract the caretaker from the owner.
    expect(accessFromClaims({ admin: true, staffRole: 'auntie' })).toEqual({
      status: 'caretaker',
    });
  });

  it('a caretaker carrying a sandbox claim stays a caretaker, with no pin', () => {
    // She is a real account working real households. Pinning her queries to a
    // test tribe would empty every screen rather than say anything.
    expect(accessFromClaims({ staffRole: 'auntie', testTribeId: 'test-kinfolk-001' })).toEqual({
      status: 'caretaker',
    });
  });

  it('DENIES an unknown future staff role rather than guessing a boundary', () => {
    // Spec §3: `staffRole: 'bookkeeper'` is neither role. Refused until someone
    // writes rules for it.
    expect(accessFromClaims({ staffRole: 'bookkeeper' })).toEqual({ status: 'denied' });
  });

  it('an owner carrying an unknown staff role is still the owner', () => {
    // Only the literal caretaker role subtracts from the owner. A typo'd or
    // future role must not lock the sole operator out of their own app.
    expect(accessFromClaims({ admin: true, staffRole: 'bookkeeper' })).toEqual({
      status: 'admin',
    });
  });

  it('the operator, who holds admin and no staffRole at all, is unchanged', () => {
    // The no-lockout property. Spec §4: nothing happens to existing accounts.
    expect(accessFromClaims({ admin: true })).toEqual({ status: 'admin' });
  });
});
