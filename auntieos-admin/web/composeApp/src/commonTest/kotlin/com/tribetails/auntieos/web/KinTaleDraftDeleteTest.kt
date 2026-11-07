package com.tribetails.auntieos.web

import com.tribetails.auntieos.web.data.KinCareReport
import com.tribetails.auntieos.web.data.canDeleteAsDraft
import com.tribetails.auntieos.web.screens.kintales.KinTaleReportViewModel
import com.tribetails.auntieos.web.screens.kintales.deleteDraftConfirmText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * #1631: on the desktop console an unsent KinTale report draft could not be
 * deleted. Only the purgeOldDrafts retention job removed one. These pin the gate
 * (the server's three refusals) and the report screen's delete.
 */
class KinTaleDraftDeleteTest {

    private val draft = KinCareReport(
        _id = "report-1",
        sessionId = "sess-1",
        kinfolkId = "kf-1",
        kinfolkName = "Robyn",
        status = "DRAFT",
        sentAt = "",
        bodyCopy = "Biscuit had a great walk.",
    )

    @Test
    fun `an unsent saved draft can be deleted`() {
        assertTrue(draft.canDeleteAsDraft())
        assertTrue(draft.copy(status = "draft").canDeleteAsDraft())
    }

    @Test
    fun `a sent KinTale, a draft with a send time and an unsaved draft cannot`() {
        assertFalse(draft.copy(status = "SENT", sentAt = "2026-11-04T19:00:00Z").canDeleteAsDraft())
        assertFalse(draft.copy(sentAt = "2026-11-04T19:00:00Z").canDeleteAsDraft())
        assertFalse(draft.copy(_id = "").canDeleteAsDraft())
    }

    @Test
    fun `an untriaged migration orphan cannot`() {
        assertFalse(draft.copy(kinfolkId = "", sentVia = "legacy_orphan").canDeleteAsDraft())
    }

    @Test
    fun `deleteDraft calls the data source and marks the screen done`() {
        val ds = FakeAuntieDataSource(existingReport = draft)
        val vm = KinTaleReportViewModel(sessionId = "sess-1", dataSource = ds)
        vm.deleteDraft(draft)
        assertEquals(listOf("report-1"), ds.deletedReportDrafts)
        assertTrue(vm.justDeleted)
        assertFalse(vm.isDeleting)
    }

    @Test
    fun `a refused delete names the reason and stays`() {
        val ds = FakeAuntieDataSource(existingReport = draft).apply { deleteReportDraftError = "has a send time" }
        val vm = KinTaleReportViewModel(sessionId = "sess-1", dataSource = ds)
        vm.deleteDraft(draft)
        assertFalse(vm.justDeleted)
        assertEquals("Delete failed: has a send time", vm.error)
    }

    @Test
    fun `deleteDraft refuses a sent KinTale without calling the server`() {
        val ds = FakeAuntieDataSource()
        val vm = KinTaleReportViewModel(sessionId = "sess-1", dataSource = ds)
        vm.deleteDraft(draft.copy(status = "SENT", sentAt = "2026-11-04T19:00:00Z"))
        assertTrue(ds.deletedReportDrafts.isEmpty())
        assertFalse(vm.justDeleted)
    }

    @Test
    fun `the confirm names the household`() {
        assertEquals(
            "This KinTale for Robyn has not been sent. Deleting it cannot be undone.",
            deleteDraftConfirmText("Robyn"),
        )
        assertEquals("This KinTale has not been sent. Deleting it cannot be undone.", deleteDraftConfirmText(""))
    }
}
