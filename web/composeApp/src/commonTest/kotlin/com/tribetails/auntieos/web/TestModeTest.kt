package com.tribetails.auntieos.web

import com.tribetails.auntieos.web.data.Invoice
import com.tribetails.auntieos.web.data.TestMode
import com.tribetails.auntieos.web.data.allowIntoApp
import com.tribetails.auntieos.web.data.applyKinfolkScope
import com.tribetails.auntieos.web.data.enforceWriteKinfolkId
import com.tribetails.auntieos.web.data.kinfolkScopeFilter
import com.tribetails.auntieos.web.data.testModeBannerVisible
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Stage 0I test-admin sandbox: pure-helper coverage. Verifies the claim ->
 * TestMode parse, the scoped-vs-unscoped query selection, the write-scope
 * enforcement, the banner-visible-when-active rule, and the auth gate. No Compose
 * UI harness needed because every decision is extracted into a pure function.
 */
class TestModeTest {

    private val tribe = "test-kinfolk-001"

    // ── claim parsing -> TestMode ─────────────────────────────────────────────

    @Test
    fun nullClaim_isOff() {
        val tm = TestMode.fromClaim(null)
        assertFalse(tm.active)
        assertNull(tm.testTribeId)
    }

    @Test
    fun blankClaim_isOff() {
        assertFalse(TestMode.fromClaim("").active)
        assertFalse(TestMode.fromClaim("   ").active)
    }

    @Test
    fun nonEmptyClaim_isActiveAndTrimmed() {
        val tm = TestMode.fromClaim("  $tribe  ")
        assertTrue(tm.active)
        assertEquals(tribe, tm.testTribeId)
    }

    // ── scoped vs unscoped query selection ────────────────────────────────────

    @Test
    fun scopeFilter_offMeansNoConstraint() {
        assertNull(kinfolkScopeFilter(TestMode.OFF))
    }

    @Test
    fun scopeFilter_activeReturnsScopedId() {
        assertEquals(tribe, kinfolkScopeFilter(TestMode.fromClaim(tribe)))
    }

    // ── post-read scope guard ─────────────────────────────────────────────────

    private fun inv(id: String, kinfolkId: String) = Invoice(_id = id, kinfolkId = kinfolkId)

    @Test
    fun applyScope_offPassesEverythingThrough() {
        val all = listOf(inv("a", tribe), inv("b", "other-tribe"))
        assertEquals(all, applyKinfolkScope(TestMode.OFF, all) { it.kinfolkId })
    }

    @Test
    fun applyScope_activeDropsCrossTribeDocs() {
        val all = listOf(inv("a", tribe), inv("b", "other-tribe"), inv("c", tribe))
        val scoped = applyKinfolkScope(TestMode.fromClaim(tribe), all) { it.kinfolkId }
        assertEquals(listOf("a", "c"), scoped.map { it._id })
    }

    // ── write-scope enforcement ───────────────────────────────────────────────

    @Test
    fun enforceWrite_offKeepsRequestedId() {
        assertEquals("whatever", enforceWriteKinfolkId(TestMode.OFF, "whatever"))
    }

    @Test
    fun enforceWrite_activeForcesScopedIdEvenIfFormSuppliedAnother() {
        // A test admin must never be able to write into another tribe's scope.
        assertEquals(tribe, enforceWriteKinfolkId(TestMode.fromClaim(tribe), "other-tribe"))
        assertEquals(tribe, enforceWriteKinfolkId(TestMode.fromClaim(tribe), ""))
    }

    // ── banner visibility ─────────────────────────────────────────────────────

    @Test
    fun banner_hiddenForNormalAdmin() {
        assertFalse(testModeBannerVisible(TestMode.OFF))
    }

    @Test
    fun banner_shownForTestAdmin() {
        assertTrue(testModeBannerVisible(TestMode.fromClaim(tribe)))
    }

    // ── auth gate ─────────────────────────────────────────────────────────────

    @Test
    fun gate_admitsRealAdmin() {
        assertTrue(allowIntoApp(isAdmin = true, testMode = TestMode.OFF))
    }

    @Test
    fun gate_admitsTestAdmin() {
        assertTrue(allowIntoApp(isAdmin = false, testMode = TestMode.fromClaim(tribe)))
    }

    @Test
    fun gate_deniesSignedInNonAdminNonTest() {
        assertFalse(allowIntoApp(isAdmin = false, testMode = TestMode.OFF))
    }
}
