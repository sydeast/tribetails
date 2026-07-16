package com.tribetails.auntieos.domain

/**
 * Stage 0I test-admin sandbox (client side).
 *
 * A test admin signs in as a normal Firebase user carrying the custom claim
 * `testTribeId` (a string, e.g. "test-kinfolk-001") and does NOT carry
 * `admin: true`. Firestore rules HARD-restrict that account to records where
 * `kinfolkId == testTribeId` (and the kinfolk doc whose id == testTribeId).
 *
 * Because rules cannot filter list queries, the CLIENT must constrain every
 * kinfolk-scoped read to `where kinfolkId == testTribeId` when in test mode, or
 * the broad reads the normal-admin path uses (e.g. the unscoped
 * `kinfolk`/`invoices`/`payments` collection reads) will be permission-denied.
 *
 * This file holds the PURE, side-effect-free decision logic so it can be unit
 * tested without Firebase: claim -> [TestMode] and the scoping selectors.
 */
data class TestMode(
    /** True iff the signed-in account carries a non-empty `testTribeId` claim. */
    val active: Boolean,
    /** The test kinfolk doc id from the claim; blank when not in test mode. */
    val testTribeId: String,
) {
    companion object {
        /** The normal-admin (non-test) state: no scoping, broad reads allowed. */
        val OFF = TestMode(active = false, testTribeId = "")

        /**
         * Derive [TestMode] from a decoded ID-token claims map.
         *
         * Active iff `testTribeId` is present, a String, and non-blank. Any other
         * shape (missing, null, non-string, blank) yields [OFF] so a malformed
         * claim never silently half-enables sandbox scoping.
         */
        fun fromClaims(claims: Map<String, Any?>?): TestMode {
            val raw = claims?.get("testTribeId")
            val id = (raw as? String)?.trim().orEmpty()
            return if (id.isNotEmpty()) TestMode(active = true, testTribeId = id) else OFF
        }
    }
}

/**
 * For a kinfolk-scoped collection read: when in test mode, return the
 * testTribeId so the caller adds `whereEqualTo("kinfolkId", <it>)`; otherwise
 * null so the caller leaves the query unscoped (normal-admin path unchanged).
 */
fun TestMode.kinfolkScopeFilter(): String? = if (active) testTribeId else null

/**
 * When in test mode, every created kinfolk-scoped doc must be stamped with
 * `kinfolkId = testTribeId` so it lands inside the sandbox and satisfies the
 * create rule. Returns the value to stamp, or [fallback] (the caller's own
 * kinfolkId) when not in test mode.
 */
fun TestMode.scopedKinfolkId(fallback: String): String = if (active) testTribeId else fallback

/**
 * Whether a kinfolk doc fetched by the test admin should be surfaced. In test
 * mode only the single doc whose id == testTribeId is reachable, so a
 * `getKinfolk()`-style list must collapse to that one doc. Returns true when
 * the doc id is in scope.
 */
fun TestMode.allowsKinfolkDoc(docId: String): Boolean = !active || docId == testTribeId
