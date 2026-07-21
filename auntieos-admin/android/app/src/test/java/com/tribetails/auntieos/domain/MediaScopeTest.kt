package com.tribetails.auntieos.domain

import com.tribetails.auntieos.data.model.MediaEntityType
import com.tribetails.auntieos.data.model.MediaFile
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

/**
 * Stage 0I media sandbox scoping (android). Mirror of the web MediaScopeTest.
 * Android already stamped kinfolkId in test mode; this pins the now-typed helper
 * shared by saveMediaFile so it can never silently regress out of lockstep.
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
        val base = MediaFile(entityId = "sess1", entityType = MediaEntityType.VISIT_LOG.name)
        val scoped = base.withSandboxScope("test-kinfolk-001")
        assertEquals("test-kinfolk-001", scoped.kinfolkId)
        assertEquals("sess1", scoped.entityId)
    }

    @Test
    fun withSandboxScope_noStampForOperator() {
        val base = MediaFile(entityId = "sess1", entityType = MediaEntityType.VISIT_LOG.name)
        assertEquals("", base.withSandboxScope(null).kinfolkId)
        assertEquals("", base.withSandboxScope("").kinfolkId)
        assertSame(base, base.withSandboxScope("   "))
    }
}
