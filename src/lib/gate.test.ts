import { describe, expect, it } from 'vitest';
import { allowIntoApp, testModeFromClaim, type TestMode } from './gate';

/**
 * The auth gate, ported from the wasm app's TestMode.kt (`allowIntoApp`,
 * `TestMode.fromClaim`). Behaviour is deliberately identical: both apps run
 * against the same Firestore rules and the same Stage 0I sandbox, so a gate that
 * disagreed with the rules would either lock the operator out or admit someone
 * the rules will then deny on every read.
 *
 * The model, which is easy to get backwards:
 *   real admin  -> `admin: true` claim, NO testTribeId, runs UNSCOPED
 *   test admin  -> `testTribeId` claim, NEVER `admin: true`, runs SCOPED
 *   anyone else -> denied
 *
 * A test admin is NOT an admin. It holds no admin claim by design, which is why
 * every admin callable rejects it (isStaff() in MyTribe/functions has never heard
 * of testTribeId) while Firestore rules still scope its reads to one household.
 * That asymmetry is the sandbox's whole safety property: it can look, and it
 * cannot send.
 */

const OFF: TestMode = { active: false, testTribeId: null };

describe('testModeFromClaim', () => {
  it('a real kinfolk-scoped claim turns test mode on', () => {
    expect(testModeFromClaim('test-kinfolk-001')).toEqual({
      active: true,
      testTribeId: 'test-kinfolk-001',
    });
  });

  it('no claim means a normal admin session, not a broken one', () => {
    expect(testModeFromClaim(undefined)).toEqual(OFF);
    expect(testModeFromClaim(null)).toEqual(OFF);
  });

  it('blank and whitespace-only claims are OFF, not an active scope of ""', () => {
    // An active scope of "" would match nothing, so every list would render empty
    // and look like a household with no data rather than a broken claim.
    expect(testModeFromClaim('')).toEqual(OFF);
    expect(testModeFromClaim('   ')).toEqual(OFF);
  });

  it('trims, so a stray space cannot produce a never-matching scope', () => {
    expect(testModeFromClaim('  test-kinfolk-001  ')).toEqual({
      active: true,
      testTribeId: 'test-kinfolk-001',
    });
  });

  it('ignores a non-string claim rather than coercing it', () => {
    // Custom claims are attacker-adjacent input: they arrive decoded from a JWT.
    // Coercing 42 to "42" would invent a scope nobody granted.
    expect(testModeFromClaim(42 as unknown as string)).toEqual(OFF);
    expect(testModeFromClaim(true as unknown as string)).toEqual(OFF);
    expect(testModeFromClaim({} as unknown as string)).toEqual(OFF);
  });
});

describe('allowIntoApp', () => {
  const scoped: TestMode = { active: true, testTribeId: 'test-kinfolk-001' };

  it('admits a real admin', () => {
    expect(allowIntoApp(true, OFF)).toBe(true);
  });

  it('admits a Stage 0I test admin, to run scoped', () => {
    expect(allowIntoApp(false, scoped)).toBe(true);
  });

  it('denies a signed-in user with neither claim', () => {
    // The whole point of the gate. A kinfolk who signs into the ADMIN app with
    // their portal credentials must not get in.
    expect(allowIntoApp(false, OFF)).toBe(false);
  });

  it('admits an admin who somehow also carries a test claim', () => {
    // Not expected (the seed never sets admin:true on the test user) but the
    // rule is OR, and failing closed here would lock out the sole operator if a
    // stray claim ever landed on their account.
    expect(allowIntoApp(true, scoped)).toBe(true);
  });
});
