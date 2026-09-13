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

    // #802: `withSandboxScope` is a `.copy(kinfolkId = ...)`, so every OTHER
    // field -- durationSeconds included -- must survive untouched. This is the
    // diff-vs-rebuild guarantee `saveMediaFile` relies on: a `.copy()` can
    // never silently zero a field it does not name, the way a screen rebuilding
    // a whole model from form state can.
    @Test
    fun withSandboxScope_preservesDurationSeconds() {
        val base = MediaFile(entityId = "sess1", entityType = MediaEntityType.VISIT_LOG.name, durationSeconds = 75)
        assertEquals(75, base.withSandboxScope("test-kinfolk-001").durationSeconds)
        assertEquals(75, base.withSandboxScope(null).durationSeconds)
    }

    // Operator ruling 2026-07-31: Kinfolk do not "own" media. A KIN/BUSINESS/...
    // upload's kinfolkId must end up ABSENT from the persisted doc, never blank
    // (HANDOFF_2026-07-25's equality-on-empty-string trap). saveMediaFile decides
    // whether to delete the field via this pure predicate.

    @Test
    fun hasBlankKinfolkId_trueForBusinessOrKinTargets() {
        val business = MediaFile(entityId = "business_settings", entityType = MediaEntityType.BUSINESS.name)
        val kin = MediaFile(entityId = "pet1", entityType = MediaEntityType.KIN.name)
        assertEquals(true, business.hasBlankKinfolkId())
        assertEquals(true, kin.hasBlankKinfolkId())
    }

    @Test
    fun hasBlankKinfolkId_falseForARealHousehold() {
        val household = MediaFile(entityId = "kf1", entityType = MediaEntityType.KINFOLK.name, kinfolkId = "kf1")
        assertEquals(false, household.hasBlankKinfolkId())
    }

    @Test
    fun hasBlankKinfolkId_falseOnceSandboxScopeIsStamped() {
        // withSandboxScope always stamps a REAL (non-blank) testTribeId when the
        // test-admin sandbox is active, regardless of entityType, so a sandbox
        // write is never blank by the time saveMediaFile checks this.
        val base = MediaFile(entityId = "business_settings", entityType = MediaEntityType.BUSINESS.name)
        val scoped = base.withSandboxScope("test-kinfolk-001")
        assertEquals(false, scoped.hasBlankKinfolkId())
    }
}
