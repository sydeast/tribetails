package com.tribetails.auntieos.web.data

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertSame

/**
 * Stage 0I media sandbox scoping (web). Mirrors android MediaScopeTest. Proves the
 * CLIENT stamps kinfolkId == testTribeId for a test admin (the gap that made the
 * sandbox media rules a false-green: the rules test seeds kinfolkId by hand, but
 * the web upload path never wrote it).
 */
class MediaScopeTest {

    @Test
    fun operatorOrMissingClaim_yieldsBlankScope() {
        assertEquals("", mediaScopeKinfolkId(null))
        assertEquals("", mediaScopeKinfolkId(""))
        assertEquals("", mediaScopeKinfolkId("   "))
    }

    @Test
    fun testAdminClaim_isTrimmed() {
        assertEquals("test-kinfolk-001", mediaScopeKinfolkId("test-kinfolk-001"))
        assertEquals("test-kinfolk-001", mediaScopeKinfolkId("  test-kinfolk-001  "))
    }

    @Test
    fun withSandboxScope_stampsForTestAdmin() {
        val base = MediaFile(entityId = "sess1", entityType = "VISIT_LOG")
        val scoped = base.withSandboxScope("test-kinfolk-001")
        assertEquals("test-kinfolk-001", scoped.kinfolkId)
        assertEquals("sess1", scoped.entityId) // other fields untouched
    }

    @Test
    fun withSandboxScope_noStampForOperator() {
        val base = MediaFile(entityId = "sess1", entityType = "VISIT_LOG")
        assertEquals("", base.withSandboxScope(null).kinfolkId)
        assertEquals("", base.withSandboxScope("").kinfolkId)
        // blank claim must NOT write a blank scope via a copy: same instance back
        assertSame(base, base.withSandboxScope("   "))
    }
}
