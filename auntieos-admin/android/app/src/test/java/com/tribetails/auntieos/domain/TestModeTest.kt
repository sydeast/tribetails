package com.tribetails.auntieos.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Stage 0I test-admin sandbox: pure decision-logic tests. Covers
 * claim -> [TestMode], the scoped-query selector, the write-stamp selector, the
 * per-doc kinfolk gate, and banner visibility. No Firebase needed.
 */
class TestModeTest {

    // ---- claim -> TestMode ----

    @Test fun `non-empty string claim activates test mode`() {
        val mode = TestMode.fromClaims(mapOf("testTribeId" to "test-kinfolk-001"))
        assertTrue(mode.active)
        assertEquals("test-kinfolk-001", mode.testTribeId)
    }

    @Test fun `claim is trimmed`() {
        val mode = TestMode.fromClaims(mapOf("testTribeId" to "  test-kinfolk-001  "))
        assertTrue(mode.active)
        assertEquals("test-kinfolk-001", mode.testTribeId)
    }

    @Test fun `missing claim yields OFF`() {
        val mode = TestMode.fromClaims(mapOf("admin" to true))
        assertFalse(mode.active)
        assertEquals(TestMode.OFF, mode)
    }

    @Test fun `null claims map yields OFF`() {
        assertEquals(TestMode.OFF, TestMode.fromClaims(null))
    }

    @Test fun `null claim value yields OFF`() {
        assertFalse(TestMode.fromClaims(mapOf("testTribeId" to null)).active)
    }

    @Test fun `blank string claim yields OFF`() {
        assertFalse(TestMode.fromClaims(mapOf("testTribeId" to "   ")).active)
    }

    @Test fun `non-string claim yields OFF`() {
        // A malformed (non-string) claim must NOT half-enable scoping.
        assertFalse(TestMode.fromClaims(mapOf("testTribeId" to 12345)).active)
        assertFalse(TestMode.fromClaims(mapOf("testTribeId" to true)).active)
    }

    @Test fun `normal admin claim does not activate test mode`() {
        val mode = TestMode.fromClaims(mapOf("admin" to true))
        assertFalse(mode.active)
    }

    // ---- scoped-query selection ----

    @Test fun `kinfolkScopeFilter returns testTribeId when active`() {
        val mode = TestMode(active = true, testTribeId = "test-kinfolk-001")
        assertEquals("test-kinfolk-001", mode.kinfolkScopeFilter())
    }

    @Test fun `kinfolkScopeFilter is null for normal admin so query stays unscoped`() {
        assertNull(TestMode.OFF.kinfolkScopeFilter())
    }

    // ---- write-stamp selection ----

    @Test fun `scopedKinfolkId forces sandbox id when active`() {
        val mode = TestMode(active = true, testTribeId = "test-kinfolk-001")
        // Even if a caller supplies a different kinfolkId, the write is forced into scope.
        assertEquals("test-kinfolk-001", mode.scopedKinfolkId("some-other-household"))
    }

    @Test fun `scopedKinfolkId passes the caller value through for normal admin`() {
        assertEquals("real-household-42", TestMode.OFF.scopedKinfolkId("real-household-42"))
    }

    // ---- per-doc kinfolk gate ----

    @Test fun `allowsKinfolkDoc only the sandbox doc when active`() {
        val mode = TestMode(active = true, testTribeId = "test-kinfolk-001")
        assertTrue(mode.allowsKinfolkDoc("test-kinfolk-001"))
        assertFalse(mode.allowsKinfolkDoc("another-kinfolk"))
    }

    @Test fun `allowsKinfolkDoc permits any doc for normal admin`() {
        assertTrue(TestMode.OFF.allowsKinfolkDoc("any-kinfolk"))
    }

    // ---- banner visibility (drives the shell TEST MODE banner) ----

    @Test fun `banner shows only when test mode active`() {
        assertTrue(TestMode(active = true, testTribeId = "x").active)
        assertFalse(TestMode.OFF.active)
    }
}
