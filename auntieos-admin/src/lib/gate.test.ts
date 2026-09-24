import { describe, expect, it } from 'vitest';
import { allowIntoApp, caretakerFromClaim, testModeFromClaim, type TestMode } from './gate';

/**
 * The auth gate, ported from the wasm app's TestMode.kt (`allowIntoApp`,
 * `TestMode.fromClaim`). Behaviour is deliberately identical: both apps run
 * against the same Firestore rules and the same Stage 0I sandbox, so a gate that
 * disagreed with the rules would either lock the operator out or admit someone
 * the rules will then deny on every read.
 *
 * The model, which is easy to get backwards:
 *   owner       -> `admin: true` claim, NO testTribeId, runs UNSCOPED
 *   caretaker   -> `staffRole: 'auntie'`, NEVER `admin: true` (#944), UNSCOPED
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

describe('caretakerFromClaim', () => {
  it('the exact role string is the caretaker', () => {
    expect(caretakerFromClaim('auntie')).toBe(true);
  });

  it('no claim is not the caretaker', () => {
    expect(caretakerFromClaim(undefined)).toBe(false);
    expect(caretakerFromClaim(null)).toBe(false);
    expect(caretakerFromClaim('')).toBe(false);
  });

  it('an unknown future staff role is NOT the caretaker', () => {
    // Spec section 3: `staffRole: 'bookkeeper'` is neither the owner nor the
    // Auntie, and must be refused everywhere until someone writes rules for it.
    // A `typeof raw === 'string'` test here would have admitted it.
    expect(caretakerFromClaim('bookkeeper')).toBe(false);
    expect(caretakerFromClaim('admin')).toBe(false);
  });

  it('does not coerce, trim or case-fold', () => {
    // Custom claims are attacker-adjacent input: they arrive decoded from a JWT.
    // `grant-staff-role.mjs` writes the literal string, so anything else is not
    // a claim this project minted and must not be read as one.
    expect(caretakerFromClaim(' auntie ')).toBe(false);
    expect(caretakerFromClaim('Auntie')).toBe(false);
    expect(caretakerFromClaim(true as unknown as string)).toBe(false);
    expect(caretakerFromClaim({} as unknown as string)).toBe(false);
  });
});

describe('allowIntoApp', () => {
  const scoped: TestMode = { active: true, testTribeId: 'test-kinfolk-001' };

  it('admits the owner', () => {
    expect(allowIntoApp(true, false, OFF)).toBe(true);
  });

  it('admits a caretaker, who carries no admin claim at all', () => {
    // #944's first blocker: before this, an Auntie authenticated and the gate
    // refused her, so the whole access level was unreachable.
    expect(allowIntoApp(false, true, OFF)).toBe(true);
  });

  it('admits a Stage 0I test admin, to run scoped', () => {
    expect(allowIntoApp(false, false, scoped)).toBe(true);
  });

  it('denies a signed-in user with none of the three claims', () => {
    // The whole point of the gate. A kinfolk who signs into the ADMIN app with
    // their portal credentials must not get in.
    expect(allowIntoApp(false, false, OFF)).toBe(false);
  });

  it('admits an owner who somehow also carries a test claim', () => {
    // Not expected (the seed never sets admin:true on the test user) but the
    // rule is OR, and failing closed here would lock out the sole operator if a
    // stray claim ever landed on their account.
    expect(allowIntoApp(true, false, scoped)).toBe(true);
  });
});
