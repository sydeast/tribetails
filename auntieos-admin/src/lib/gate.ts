/**
 * The auth gate. Ported from the wasm app's `TestMode.kt` so both admins agree
 * with each other and, more importantly, with firestore.rules.
 *
 * A "test admin" is a real Firebase Auth user that does NOT carry `admin: true`
 * but DOES carry `testTribeId` (a kinfolk doc id, e.g. "test-kinfolk-001").
 * Firestore rules hard-restrict that user to the one kinfolk whose id ==
 * testTribeId plus records where `kinfolkId == testTribeId`.
 *
 * Worth stating plainly, because it reads like a bug: a test admin holds NO admin
 * claim on purpose. MyTribe's `isStaff()` has never heard of `testTribeId`, so
 * every admin callable rejects it while the rules still let it read the sandbox
 * household. That asymmetry IS the safety property. The sandbox account can drive
 * the whole UI and cannot broadcast, text, or invoice a real client, because the
 * server will not let it.
 *
 * ISSUE #944 ADDED A THIRD WAY IN: the caretaker, who carries
 * `staffRole: 'auntie'` and NO `admin` claim
 * (docs/superpowers/specs/2026-09-22-admin-auntie-access-design.md). Before
 * this she authenticated and was refused here, so the whole access level was
 * unreachable.
 *
 * `allowIntoApp` therefore takes three arguments where `TestMode.kt`'s twin
 * still takes two. THAT DIVERGENCE IS REAL AND IS NOT AN OVERSIGHT: the Compose
 * web/desktop client (`web/composeApp/.../data/TestMode.kt:93`, gated at
 * `App.kt:148`) and Android have not been taught the role, so an Auntie still
 * cannot sign in to either. Teaching them is the client follow-up; it is named
 * here so the next person reading the two files does not assume they agree.
 */

export interface TestMode {
  readonly active: boolean;
  readonly testTribeId: string | null;
}

export const TEST_MODE_OFF: TestMode = { active: false, testTribeId: null };

/**
 * Parse the raw `testTribeId` custom claim into a [TestMode].
 *
 * Claims arrive decoded from a JWT, so this is untrusted-shaped input even though
 * the token itself is signed: anything that is not a non-blank string means "not a
 * test admin". Deliberately NOT coercing: an active scope of `""` would match no
 * documents, so every list would render empty and read as a household with no
 * data rather than as a broken claim.
 */
export function testModeFromClaim(raw: unknown): TestMode {
  if (typeof raw !== 'string') return TEST_MODE_OFF;
  const trimmed = raw.trim();
  return trimmed === '' ? TEST_MODE_OFF : { active: true, testTribeId: trimmed };
}

/**
 * The value of the `staffRole` custom claim that means "caretaker".
 *
 * Kept identical to `mytribe/functions/src/lib/auntieAccess.ts#STAFF_ROLE_AUNTIE`
 * and to `hasAuntieRole()` in `mytribe/firestore.rules`. Three copies of one
 * string, because the two trees deploy separately; if this one drifts the app
 * admits nobody rather than admitting the wrong body, which is the safe side.
 */
export const STAFF_ROLE_AUNTIE = 'auntie';

/**
 * Does this raw `staffRole` claim mean the caretaker?
 *
 * EXACT MATCH, NOT "carries a staffRole". The spec is explicit that an unknown
 * future role — `staffRole: 'bookkeeper'` — is neither the owner nor the
 * caretaker and must be refused everywhere until someone writes rules for it.
 * Anything that is not the literal string is not the caretaker.
 */
export function caretakerFromClaim(raw: unknown): boolean {
  return raw === STAFF_ROLE_AUNTIE;
}

/**
 * Whether the gate should admit this signed-in user.
 *
 * Owner -> always. Caretaker -> yes, on the caretaker boundary. Stage 0I test
 * admin -> yes, scoped. None of the three -> denied, which is what stops a
 * kinfolk signing into the admin app with their portal credentials.
 *
 * `isOwner` is the OWNER signal, not the raw `admin` claim: an account holding
 * both claims is a minting mistake and degrades to the caretaker, exactly as
 * `firestore.rules:isOwner()` and `lib/staffGate.ts:isOwnerClaim()` do. See
 * `accessFromClaims`, which is where that subtraction happens.
 */
export function allowIntoApp(isOwner: boolean, isCaretaker: boolean, testMode: TestMode): boolean {
  return isOwner || isCaretaker || testMode.active;
}

/** True while the sandbox banner should be showing. */
export function testModeBannerVisible(testMode: TestMode): boolean {
  return testMode.active;
}
