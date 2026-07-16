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
 * Whether the gate should admit this signed-in user.
 *
 * Real admin -> always. Stage 0I test admin -> yes, scoped. Neither -> denied,
 * which is what stops a kinfolk signing into the admin app with their portal
 * credentials.
 */
export function allowIntoApp(isAdmin: boolean, testMode: TestMode): boolean {
  return isAdmin || testMode.active;
}

/** True while the sandbox banner should be showing. */
export function testModeBannerVisible(testMode: TestMode): boolean {
  return testMode.active;
}
