package com.tribetails.auntieos.web

import com.tribetails.auntieos.web.data.KinCareReport
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.data.VisitCompletionAfterSend
import com.tribetails.auntieos.web.data.sentButNotCompletedNotice
import com.tribetails.auntieos.web.screens.kintales.ComposerAfterSend
import com.tribetails.auntieos.web.screens.kintales.KinTaleReportViewModel
import com.tribetails.auntieos.web.screens.kintales.composerAfterSend
import com.tribetails.auntieos.web.screens.kintales.justSentBannerText
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #1799: the KinTale report screen's send (`sendReport`) also completes a
 * DEPARTED visit afterwards. The completion is asked for only after the send
 * went through, and its answer never reads as a failed send.
 */
class KinTaleReportCompletionTest {

    private val session = KinCareSession(_id = "sess-1", kinfolkId = "kf-1", sourceBookingId = "bk-1", status = "DEPARTED")
    private val live = KinCareReport(_id = "report-1", sessionId = "sess-1")

    private fun send(ds: FakeAuntieDataSource, scope: kotlinx.coroutines.CoroutineScope): KinTaleReportViewModel {
        val vm = KinTaleReportViewModel(sessionId = "sess-1", dataSource = ds, scope = scope)
        vm.updateBodyCopy("Biscuit had a long walk.")
        vm.send(live, session)
        return vm
    }

    @Test
    fun aSendThatWentThroughAsksForTheCompletionOfThatVisit() = runTest {
        val ds = FakeAuntieDataSource().apply { completionAfterSend = VisitCompletionAfterSend.Completed }
        val vm = send(ds, this)
        advanceUntilIdle()
        assertEquals(listOf("sess-1"), ds.completionRequests)
        assertEquals(VisitCompletionAfterSend.Completed, vm.visitCompletion)
        assertTrue(vm.justSent)
        assertFalse(vm.isSending)
        assertNull(vm.error)
    }

    @Test
    fun aRefusedCompletionIsStillASentTaleNeverAnError() = runTest {
        val refusal = "The arrival was recorded 900 m from the household."
        val ds = FakeAuntieDataSource().apply { completionAfterSend = VisitCompletionAfterSend.NotCompleted(refusal) }
        val vm = send(ds, this)
        advanceUntilIdle()
        assertTrue(vm.justSent)
        assertNull(vm.error)
        assertEquals(VisitCompletionAfterSend.NotCompleted(refusal), vm.visitCompletion)
    }

    @Test
    fun aFailedSendNeverAsksForTheCompletion() = runTest {
        val ds = FakeAuntieDataSource(sendShouldFail = true, sendFailMessage = "unavailable")
        val vm = send(ds, this)
        advanceUntilIdle()
        assertTrue(ds.completionRequests.isEmpty())
        assertNull(vm.visitCompletion)
        assertFalse(vm.justSent)
        assertTrue(vm.error!!.contains("unavailable"))
    }

    /** The composer (`KinTaleComposeScreen`), the other send path on this console. */
    @Test
    fun theComposerClosesOnASendThatCompletedOrLeftTheVisitOpen() {
        assertEquals(
            ComposerAfterSend.Close("KinTale sent and the visit is marked Completed. Kinfolk will hear from you soon."),
            composerAfterSend(VisitCompletionAfterSend.Completed),
        )
        assertEquals(
            ComposerAfterSend.Close("KinTale sent. Kinfolk will hear from you soon."),
            composerAfterSend(VisitCompletionAfterSend.LeftOpen("ARRIVED")),
        )
    }

    @Test
    fun theComposerStaysOnTheReasonWhenTheCompletionIsRefused() {
        val refusal = "The arrival was recorded 900 m from the household."
        assertEquals(
            ComposerAfterSend.StayWithNotice(
                "KinTale sent. Kinfolk will hear from you soon. The visit could not be marked Completed. " +
                    "The arrival was recorded 900 m from the household. You can mark it Completed from Auntie Time.",
            ),
            composerAfterSend(VisitCompletionAfterSend.NotCompleted(refusal)),
        )
    }

    @Test
    fun theSentBannerSaysWhatHappenedToTheVisit() {
        assertEquals("This KinTale has been sent.", justSentBannerText(null))
        assertEquals(
            "KinTale sent and the visit is marked Completed. Kinfolk will hear from you soon.",
            justSentBannerText(VisitCompletionAfterSend.Completed),
        )
        assertEquals(
            "KinTale sent. Kinfolk will hear from you soon.",
            justSentBannerText(VisitCompletionAfterSend.LeftOpen("ARRIVED")),
        )
        assertEquals(
            sentButNotCompletedNotice("Too far."),
            justSentBannerText(VisitCompletionAfterSend.NotCompleted("Too far.")),
        )
    }
}
