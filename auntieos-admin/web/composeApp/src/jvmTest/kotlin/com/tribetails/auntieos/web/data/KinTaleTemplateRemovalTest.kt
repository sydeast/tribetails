package com.tribetails.auntieos.web.data

import kotlinx.coroutines.runBlocking
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * #1591, operator ruling 2026-11-05 docket: "both". Remove archives (the doc
 * stays, restorable); delete for good only from the archive, behind the count.
 */
class KinTaleTemplateRemovalTest {
    @AfterTest fun tearDown() { JvmFirestoreFixtures.clear() }

    private val tpl = KinTaleTemplate(_id = "walk.standard", name = "Walk", isDefault = true)

    @Test fun archiveWritesOnlyTheArchiveFields() = runBlocking {
        FirestoreClient().removeKinTaleTemplate(tpl, KinTaleTemplateRemoval.ARCHIVE, at = "2026-11-06T18:00:00Z")
        val write = assertNotNull(JvmFirestoreFixtures.lastWrite, "no REST write was attempted")
        assertEquals("MERGE", write.op)
        assertEquals("kintale_templates", write.collection)
        assertEquals("walk.standard", write.id)
        assertEquals(setOf("archived", "archivedAt", "updatedAt"), write.fields)
    }

    @Test fun restoreThatGivesUpTheDefaultAlsoWritesIsDefault() = runBlocking {
        val archived = tpl.copy(archived = true, archivedAt = "x")
        FirestoreClient().removeKinTaleTemplate(archived, KinTaleTemplateRemoval.RESTORE, clearDefault = true, at = "y")
        val write = assertNotNull(JvmFirestoreFixtures.lastWrite)
        assertEquals(setOf("archived", "archivedAt", "updatedAt", "isDefault"), write.fields)
    }

    @Test fun deleteIssuesADocumentDelete() = runBlocking {
        FirestoreClient().removeKinTaleTemplate(tpl.copy(archived = true), KinTaleTemplateRemoval.DELETE)
        val write = assertNotNull(JvmFirestoreFixtures.lastWrite, "no REST write was attempted")
        assertEquals("DELETE", write.op)
        assertEquals("kintale_templates", write.collection)
        assertEquals("walk.standard", write.id)
    }

    private fun usage(kintaleCount: Int = 0, isDefault: Boolean = false, others: Int = 2) =
        KinTaleTemplateUsage("t1", true, "Dog walk recap", isDefault, true, kintaleCount, others, archived = true)

    @Test fun nothingDependingOnTheTemplateSaysNothing() =
        assertTrue(kinTaleTemplateRemovalImpact(usage()).isEmpty())

    // #2058: a sent KinTale keeps its own copy of the care tasks, so the confirm
    // says so, once, and never repeats the count or explains the feed.
    @Test fun namesTheKinTalesThatUseItSingularAndPlural() {
        assertEquals(listOf("KinTales already sent keep their care tasks."), kinTaleTemplateRemovalImpact(usage(kintaleCount = 1)))
        assertEquals(listOf("KinTales already sent keep their care tasks."), kinTaleTemplateRemovalImpact(usage(kintaleCount = 3)))
        assertFalse(kinTaleTemplateRemovalImpact(usage(kintaleCount = 3)).joinToString(" ").contains("written from"))
    }

    @Test fun theDeleteConfirmLeadsWithTheCount() {
        assertEquals("No KinTale was written from this template.", kinTaleTemplateDeleteHeadline(usage()))
        assertEquals("7 KinTales were written from this template.", kinTaleTemplateDeleteHeadline(usage(kintaleCount = 7)))
    }

    @Test fun archivingSaysItIsRestorable() {
        assertTrue(kinTaleTemplateArchiveImpact(false).joinToString(" ").contains("restore it from the archive"))
        assertTrue(kinTaleTemplateArchiveImpact(true).joinToString(" ").contains("default template"))
    }

    @Test fun restoreDropsTheDefaultOnlyWhenAnotherLiveTemplateTookIt() {
        val me = KinTaleTemplate(_id = "t1", isDefault = true, archived = true)
        assertFalse(kinTaleTemplateRestoreClearsDefault(me, listOf(me, KinTaleTemplate(_id = "t2"))))
        assertTrue(kinTaleTemplateRestoreClearsDefault(me, listOf(me, KinTaleTemplate(_id = "t2", isDefault = true))))
        assertFalse(kinTaleTemplateRestoreClearsDefault(me, listOf(KinTaleTemplate(_id = "t2", isDefault = true, archived = true))))
    }

    @Test fun anArchivedTemplateIsNeverPickedForANewKinTale() {
        val list = listOf(
            KinTaleTemplate(_id = "old", name = "Old walk", serviceTypeKeys = listOf("Dog Walk"), archived = true),
            KinTaleTemplate(_id = "oldDefault", name = "Old default", isDefault = true, archived = true),
            KinTaleTemplate(_id = "std", name = "Standard", isDefault = true),
        )
        assertEquals("std", pickActiveTemplate(list, "Dog Walk")._id)
        assertEquals(DefaultKinTaleTemplate.template, pickActiveTemplate(list.take(2), "Dog Walk"))
    }
    @Test fun decodesTheCallablePayload() {
        val u = decodeKinTaleTemplateUsage(
            """{"templateId":"t1","exists":true,"name":"Dog walk recap","isDefault":true,"isActive":false,"archived":true,"kintaleCount":4,"otherActiveTemplateCount":1}""",
        )
        assertEquals(KinTaleTemplateUsage("t1", true, "Dog walk recap", true, false, 4, 1, archived = true), u)
    }

    @Test fun anEmptyPayloadReadsAsNothingUsesIt() {
        val u = decodeKinTaleTemplateUsage("{}")
        assertEquals(0, u.kintaleCount)
        assertFalse(u.exists)
        assertFalse(u.archived)
    }
}
