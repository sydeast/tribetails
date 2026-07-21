package com.tribetails.auntieos.web.data

import androidx.compose.runtime.staticCompositionLocalOf

/**
 * Stage 0I test-admin sandbox client state.
 *
 * A "test admin" is a real Firebase Auth user that does NOT carry `admin: true`
 * but DOES carry a custom claim `testTribeId` (a kinfolk document id, e.g.
 * "test-kinfolk-001"). Firestore rules HARD-restrict that user to the one kinfolk
 * whose id == testTribeId plus the records where `kinfolkId == testTribeId`, so
 * the client MUST constrain every kinfolk-related list query to that scope or it
 * gets permission-denied.
 *
 * [active] is true iff [testTribeId] is a non-blank string. The normal-admin path
 * (no claim) leaves this OFF and every query/write path is unchanged.
 */
data class TestMode(
    val active: Boolean = false,
    val testTribeId: String? = null,
) {
    companion object {
        val OFF = TestMode(active = false, testTribeId = null)

        /**
         * Pure: parse the raw `testTribeId` claim value into a [TestMode]. A null,
         * blank, or whitespace-only claim means "not a test admin" (OFF). Trimmed
         * so a stray space in the claim can't produce a never-matching scope.
         */
        fun fromClaim(rawTestTribeId: String?): TestMode {
            val trimmed = rawTestTribeId?.trim().orEmpty()
            return if (trimmed.isEmpty()) OFF
            else TestMode(active = true, testTribeId = trimmed)
        }
    }
}

/**
 * Test mode for the running session, provided at the app root. Defaults to OFF so
 * any composable read outside the signed-in tree behaves as a normal admin.
 */
val LocalTestMode = staticCompositionLocalOf { TestMode.OFF }

/**
 * Pure query-scope decision: given the current [TestMode] for a kinfolk-keyed
 * collection, return the `kinfolkId` value the client must constrain the list
 * query to, or null to mean "no constraint, read the whole collection" (normal
 * admin path). Centralised + unit-tested so the scoped-vs-unscoped choice is one
 * decision, not scattered per stream.
 */
fun kinfolkScopeFilter(testMode: TestMode): String? =
    if (testMode.active) testMode.testTribeId else null

/**
 * Pure in-memory guard applied AFTER a read, belt-and-suspenders for collections
 * whose platform stream can't be re-pointed to a `where(kinfolkId ==)` query at
 * the source (e.g. a single-doc kinfolk stream, or a collection read returning
 * everything). In test mode it keeps only the docs whose [kinfolkIdOf] equals the
 * scoped id; out of test mode it returns the list untouched.
 */
inline fun <T> applyKinfolkScope(
    testMode: TestMode,
    items: List<T>,
    kinfolkIdOf: (T) -> String,
): List<T> {
    val scope = kinfolkScopeFilter(testMode) ?: return items
    return items.filter { kinfolkIdOf(it) == scope }
}

/**
 * Pure write guard: the `kinfolkId` a created doc MUST carry so it passes the
 * test-admin create rule (`request.resource.data.kinfolkId == testScope()`). In
 * normal-admin mode it returns [requested] unchanged (the caller's own value); in
 * test mode it FORCES the scoped id regardless of what the form supplied, so a
 * test admin can never write a doc into another tribe's scope.
 */
fun enforceWriteKinfolkId(testMode: TestMode, requested: String): String =
    if (testMode.active) testMode.testTribeId ?: requested else requested

/**
 * Pure: whether the shell must paint the persistent TEST MODE banner. True iff a
 * test admin is signed in; the normal-admin shell shows no banner. Unit-tested so
 * the banner-visibility rule is verified without a Compose UI harness.
 */
fun testModeBannerVisible(testMode: TestMode): Boolean = testMode.active

/**
 * Pure: whether the auth gate should admit this signed-in user. A real admin is
 * always admitted; a Stage 0I test admin (claim present) is admitted to run
 * scoped; a signed-in user with neither is denied. Centralised + tested so the
 * gate rule lives in one place.
 */
fun allowIntoApp(isAdmin: Boolean, testMode: TestMode): Boolean = isAdmin || testMode.active
