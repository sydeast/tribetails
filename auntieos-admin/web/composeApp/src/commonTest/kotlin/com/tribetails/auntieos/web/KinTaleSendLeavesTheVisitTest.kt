package com.tribetails.auntieos.web

import com.tribetails.auntieos.web.data.KINTALE_SENT_MESSAGE
import com.tribetails.auntieos.web.data.KinCareReport
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.screens.kintales.KinTaleReportViewModel
import com.tribetails.auntieos.web.screens.kintales.justSentBannerText
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #2123: a visit is Completed at departure, so sending its KinTale only sends
 * the KinTale. The send no longer asks for the visit to be completed (#1799
 * did), and what the console says afterwards is about the KinTale alone.
 */
class KinTaleSendLeavesTheVisitTest {

    private val session = KinCareSession(_id = "sess-1", kinfolkId = "kf-1", sourceBookingId = "bk-1", status = "COMPLETED")
    private val live = KinCareReport(_id = "report-1", sessionId = "sess-1")

    private fun send(ds: FakeAuntieDataSource, scope: kotlinx.coroutines.CoroutineScope): KinTaleReportViewModel {
        val vm = KinTaleReportViewModel(sessionId = "sess-1", dataSource = ds, scope = scope)
        vm.updateBodyCopy("Biscuit had a long walk.")
        vm.send(live, session)
        return vm
    }

    @Test
    fun aSendThatWentThroughIsSentAndNothingElse() = runTest {
        val ds = FakeAuntieDataSource()
        val vm = send(ds, this)
        advanceUntilIdle()
        assertEquals("sess-1", ds.lastSendSession?._id)
        assertTrue(vm.justSent)
        assertFalse(vm.isSending)
        assertNull(vm.error)
    }

    @Test
    fun aFailedSendSaysSoAndIsNotMarkedSent() = runTest {
        val ds = FakeAuntieDataSource(sendShouldFail = true, sendFailMessage = "unavailable")
        val vm = send(ds, this)
        advanceUntilIdle()
        assertFalse(vm.justSent)
        assertTrue(vm.error!!.contains("unavailable"))
    }

    @Test
    fun theSentBannerNamesOnlyTheKinTale() {
        assertEquals(KINTALE_SENT_MESSAGE, justSentBannerText())
        assertFalse(justSentBannerText().contains("Completed"))
    }
}
