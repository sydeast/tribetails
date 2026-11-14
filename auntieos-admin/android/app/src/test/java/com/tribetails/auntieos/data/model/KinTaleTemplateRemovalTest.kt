package com.tribetails.auntieos.data.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #1591, operator ruling 2026-11-05 docket: "both". Remove archives
 * (restorable); delete for good only from the archive, with the usage count.
 */
class KinTaleTemplateRemovalTest {

    private fun usage(
        kintaleCount: Int = 0,
        isDefault: Boolean = false,
        others: Int = 2,
    ) = KinTaleTemplateUsage("t1", true, "Dog walk recap", isDefault, true, kintaleCount, others, archived = true)

    @Test
    fun nothingDependingOnTheTemplateSaysNothing() {
        assertTrue(kinTaleTemplateRemovalImpact(usage()).isEmpty())
    }

    // #2058: a sent KinTale keeps its own copy of the care tasks, so the confirm

    // says so, once, and never repeats the count or explains the feed.

    @Test

    fun namesTheKinTalesThatUseItSingularAndPlural() {

        assertEquals(listOf("KinTales already sent keep their care tasks."), kinTaleTemplateRemovalImpact(usage(kintaleCount = 1)))

        assertEquals(listOf("KinTales already sent keep their care tasks."), kinTaleTemplateRemovalImpact(usage(kintaleCount = 3)))

        assertFalse(kinTaleTemplateRemovalImpact(usage(kintaleCount = 3)).joinToString(" ").contains("written from"))

    }

    @Test
    fun theDeleteConfirmLeadsWithTheCount() {
        assertEquals("No KinTale was written from this template.", kinTaleTemplateDeleteHeadline(usage()))
        assertEquals("1 KinTale was written from this template.", kinTaleTemplateDeleteHeadline(usage(kintaleCount = 1)))
        assertEquals("7 KinTales were written from this template.", kinTaleTemplateDeleteHeadline(usage(kintaleCount = 7)))
    }

    @Test
    fun archivingSaysItIsRestorableAndWhatArchivingTheDefaultMeans() {
        assertEquals(2, kinTaleTemplateArchiveImpact(isDefault = false).size)
        assertTrue(kinTaleTemplateArchiveImpact(false).joinToString(" ").contains("restore it from the archive"))
        assertTrue(kinTaleTemplateArchiveImpact(true).joinToString(" ").contains("default template"))
    }

    @Test
    fun restoreDropsTheDefaultOnlyWhenAnotherLiveTemplateTookIt() {
        val me = KinTaleTemplate(id = "t1", isDefault = true, archived = true)
        assertFalse(kinTaleTemplateRestoreClearsDefault(me, listOf(me, KinTaleTemplate(id = "t2"))))
        assertTrue(kinTaleTemplateRestoreClearsDefault(me, listOf(me, KinTaleTemplate(id = "t2", isDefault = true))))
        assertFalse(
            kinTaleTemplateRestoreClearsDefault(me, listOf(KinTaleTemplate(id = "t2", isDefault = true, archived = true))),
        )
    }

    @Test
    fun decodesTheCallablePayload() {
        val u = parseKinTaleTemplateUsage(
            mapOf(
                "templateId" to "t1", "exists" to true, "name" to "Dog walk recap", "isDefault" to true,
                "isActive" to false, "kintaleCount" to 4L, "otherActiveTemplateCount" to 1.0, "archived" to true,
            ),
        )
        assertEquals(KinTaleTemplateUsage("t1", true, "Dog walk recap", true, false, 4, 1, archived = true), u)
    }

    @Test
    fun anEmptyPayloadReadsAsNothingUsesIt() {
        val u = parseKinTaleTemplateUsage(emptyMap())
        assertEquals(0, u.kintaleCount)
        assertFalse(u.exists)
        assertFalse(u.archived)
    }
}
