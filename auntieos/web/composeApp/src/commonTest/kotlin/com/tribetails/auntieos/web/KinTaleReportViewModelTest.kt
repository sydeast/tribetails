package com.tribetails.auntieos.web

import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.Kin
import com.tribetails.auntieos.web.data.KinCareReport
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.screens.kintales.KinTaleReportViewModel
import com.tribetails.auntieos.web.screens.kintales.kinHeading
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Tests the redesigned KinTaleReportViewModel: state is held in mutableState props
 * (bodyDraft / isSending / isDraftSaved / justSent / error) and saveDraft/send take
 * the latest live report (P0-FLICKER: the body comes from the stream, the local edit
 * overrides only while the auntie is typing). saveReport/sendReport are backed.
 */
class KinTaleReportViewModelTest {

    private fun vm(
        saveShouldFail: Boolean = false,
        saveFailMessage: String = "write failed",
        sendShouldFail: Boolean = false,
        sendFailMessage: String = "send failed",
        existingReport: KinCareReport? = null,
        scope: CoroutineScope? = null,
    ): KinTaleReportViewModel {
        val ds = FakeAuntieDataSource(
            saveShouldFail = saveShouldFail,
            saveFailMessage = saveFailMessage,
            sendShouldFail = sendShouldFail,
            sendFailMessage = sendFailMessage,
            existingReport = existingReport,
        )
        return if (scope != null) {
            KinTaleReportViewModel(sessionId = "sess-1", dataSource = ds, scope = scope)
        } else {
            KinTaleReportViewModel(sessionId = "sess-1", dataSource = ds)
        }
    }

    private fun live(body: String = "") = KinCareReport(_id = "report-1", sessionId = "sess-1", bodyCopy = body)

    /** A routable session: has the kinfolkId + sourceBookingId the send path needs. */
    private fun session(
        kinfolkId: String = "kf-1",
        sourceBookingId: String = "bk-1",
    ) = KinCareSession(_id = "sess-1", kinfolkId = kinfolkId, sourceBookingId = sourceBookingId)

    @Test
    fun `initial state is idle`() {
        val v = vm()
        assertFalse(v.isSending)
        assertFalse(v.isDraftSaved)
        assertFalse(v.justSent)
        assertNull(v.error)
        assertNull(v.bodyDraft)
    }

    @Test
    fun `effectiveBody falls back to live report body when no local edit`() {
        val v = vm()
        assertEquals("Luna had a great walk!", v.effectiveBody("Luna had a great walk!"))
    }

    @Test
    fun `updateBodyCopy overrides the live body and clears saved flag`() {
        val v = vm()
        v.updateBodyCopy("Max ate all his food!")
        assertEquals("Max ate all his food!", v.bodyDraft)
        assertEquals("Max ate all his food!", v.effectiveBody("ignored live body"))
        assertFalse(v.isDraftSaved)
    }

    @Test
    fun `send with empty body sets error and does not send`() = runTest {
        val v = vm(scope = this)
        v.send(live(body = ""), session())
        advanceUntilIdle()
        assertFalse(v.justSent)
        assertTrue(v.error != null)
    }

    @Test
    fun `send success transitions to justSent`() = runTest {
        val v = vm(scope = this)
        v.updateBodyCopy("Great visit today!")
        v.send(live(), session())
        advanceUntilIdle()
        assertTrue(v.justSent)
        assertFalse(v.isSending)
        assertNull(v.error)
    }

    @Test
    fun `send failure sets error`() = runTest {
        val v = vm(sendShouldFail = true, sendFailMessage = "network error", scope = this)
        v.updateBodyCopy("Great visit today!")
        v.send(live(), session())
        advanceUntilIdle()
        assertFalse(v.justSent)
        assertFalse(v.isSending)
        assertTrue(v.error?.contains("network error") == true)
    }

    // ---- Slice 5: delivery receipt + routing-guard fail-loud ----

    @Test
    fun `send with no session sets error and does not send`() = runTest {
        val v = vm(scope = this)
        v.updateBodyCopy("Great visit today!")
        v.send(live(), null)
        advanceUntilIdle()
        assertFalse(v.justSent)
        assertTrue(v.error?.contains("session") == true)
    }

    @Test
    fun `send routes report and session through the send contract`() = runTest {
        val ds = FakeAuntieDataSource(existingReport = live())
        ds.sendDeliveryReceiptId = "n8n_42"
        val v = KinTaleReportViewModel(sessionId = "sess-1", dataSource = ds, scope = this)
        v.updateBodyCopy("Great visit today!")
        v.send(live(), session())
        advanceUntilIdle()
        assertTrue(v.justSent)
        // The VM threads the saved report id + the live session (with its routing
        // keys) into the data source; the fake stamps sentVia=catalog + the receipt.
        assertEquals("report-1", ds.lastSendReport?._id)
        assertEquals("bk-1", ds.lastSendSession?.sourceBookingId)
        assertEquals("kf-1", ds.lastSendSession?.kinfolkId)
    }

    @Test
    fun `send blocks SENT when session is not booking-originated`() = runTest {
        val v = vm(scope = this)
        v.updateBodyCopy("Great visit today!")
        v.send(live(), session(sourceBookingId = ""))
        advanceUntilIdle()
        assertFalse(v.justSent)
        assertTrue(v.error?.contains("booking-originated") == true)
    }

    @Test
    fun `saveDraft success sets isDraftSaved true`() = runTest {
        val v = vm(scope = this)
        v.updateBodyCopy("Bella napped most of the day.")
        v.saveDraft(live())
        advanceUntilIdle()
        assertTrue(v.isDraftSaved)
        assertNull(v.error)
    }

    @Test
    fun `saveDraft failure sets error`() = runTest {
        val v = vm(saveShouldFail = true, saveFailMessage = "quota exceeded", scope = this)
        v.updateBodyCopy("Some content.")
        v.saveDraft(live())
        advanceUntilIdle()
        assertFalse(v.isDraftSaved)
        assertTrue(v.error?.contains("quota exceeded") == true)
    }

    // ---- NOTE-63: saveDraft in-flight guard ----

    @Test
    fun `saveDraft drops a second call while the first is in-flight`() = runTest {
        val ds = FakeAuntieDataSource()
        val gate = kotlinx.coroutines.CompletableDeferred<Unit>()
        ds.saveGate = gate
        val v = KinTaleReportViewModel(sessionId = "sess-1", dataSource = ds, scope = this)

        v.updateBodyCopy("First content.")
        v.saveDraft(live())        // enters saveReport, suspends on the gate
        advanceUntilIdle()
        assertTrue(v.isSaving)
        assertEquals(1, ds.saveReportCalls)

        // Second call must be dropped by the guard, not queued.
        v.saveDraft(live())
        advanceUntilIdle()
        assertEquals(1, ds.saveReportCalls)

        // Release the first; the guard clears and the save commits.
        gate.complete(Unit)
        advanceUntilIdle()
        assertFalse(v.isSaving)
        assertTrue(v.isDraftSaved)
    }

    @Test
    fun `saveDraft clears isSaving after a failed write so a retry is allowed`() = runTest {
        val ds = FakeAuntieDataSource(saveShouldFail = true, saveFailMessage = "boom")
        val v = KinTaleReportViewModel(sessionId = "sess-1", dataSource = ds, scope = this)
        v.updateBodyCopy("Some content.")
        v.saveDraft(live())
        advanceUntilIdle()
        assertFalse(v.isSaving)
        assertTrue(v.error?.contains("boom") == true)

        // The guard is clear, so a retry actually fires a second write.
        v.saveDraft(live())
        advanceUntilIdle()
        assertEquals(2, ds.saveReportCalls)
    }

    // ---- Slice 3: headline (title) persistence ----

    @Test
    fun `updateTitle overrides live title and clears saved flag`() {
        val v = vm()
        v.updateTitle("Checking on Biscuit")
        assertEquals("Checking on Biscuit", v.titleDraft)
        assertEquals("Checking on Biscuit", v.effectiveTitle("ignored live title"))
        assertFalse(v.isDraftSaved)
    }

    @Test
    fun `effectiveTitle falls back to live title when untouched`() {
        val v = vm()
        assertEquals("Live headline", v.effectiveTitle("Live headline"))
    }

    @Test
    fun `saveDraft persists the typed title on the captured report`() = runTest {
        val ds = FakeAuntieDataSource()
        val v = KinTaleReportViewModel(sessionId = "sess-1", dataSource = ds, scope = this)
        v.updateTitle("Checking on Biscuit")
        v.updateBodyCopy("Great visit today.")
        v.saveDraft(live())
        advanceUntilIdle()
        assertTrue(v.isDraftSaved)
        assertEquals("Checking on Biscuit", ds.lastSavedReport?.title)
        assertEquals("Great visit today.", ds.lastSavedReport?.bodyCopy)
    }

    @Test
    fun `saveDraft failure surfaces error and does not lose the title`() = runTest {
        val ds = FakeAuntieDataSource(saveShouldFail = true, saveFailMessage = "quota exceeded")
        val v = KinTaleReportViewModel(sessionId = "sess-1", dataSource = ds, scope = this)
        v.updateTitle("Checking on Biscuit")
        v.saveDraft(live())
        advanceUntilIdle()
        assertFalse(v.isDraftSaved)
        assertTrue(v.error?.contains("quota exceeded") == true)
        // Local draft is intact so a retry still carries the headline.
        assertEquals("Checking on Biscuit", v.titleDraft)
    }

    @Test
    fun `clearError resets error to null`() = runTest {
        val v = vm(scope = this)
        v.send(live(body = ""), session())
        advanceUntilIdle()
        assertTrue(v.error != null)
        v.clearError()
        assertNull(v.error)
    }

    // ---- Slice 9: kinHeading join integration (kinStream -> kinById -> heading) ----
    // Drives the real VM kinStream() through FakeAuntieDataSource.allKinStream and
    // resolves the per-kin checklist heading exactly as the screen does (collect the
    // stream, build kinById, call kinHeading). Asserts the full join, not just the
    // pure helper. Happy/empty/error.

    private fun kinByIdFrom(result: FirestoreResult<List<Kin>>): Map<String, Kin> =
        (result as? FirestoreResult.Data)?.value?.associateBy { it._id } ?: emptyMap()

    @Test
    fun `kinStream join resolves real name species breed`() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitKin(FirestoreResult.Data(listOf(Kin(_id = "k1", name = "Biscuit", species = "Dog", breed = "Labrador"))))
        val v = KinTaleReportViewModel(sessionId = "sess-1", dataSource = ds, scope = this)

        val kinById = kinByIdFrom(v.kinStream().first())
        assertEquals("Biscuit · Dog · Labrador", kinHeading("k1", kinById))
    }

    @Test
    fun `kinStream empty falls back to raw kinId`() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitKin(FirestoreResult.Data(emptyList()))
        val v = KinTaleReportViewModel(sessionId = "sess-1", dataSource = ds, scope = this)

        val kinById = kinByIdFrom(v.kinStream().first())
        assertEquals("k1", kinHeading("k1", kinById))
    }

    @Test
    fun `kinStream error keeps join empty and shows raw id no crash`() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitKin(FirestoreResult.Error("kin listener failed"))
        val v = KinTaleReportViewModel(sessionId = "sess-1", dataSource = ds, scope = this)

        val result = v.kinStream().first()
        assertTrue(result is FirestoreResult.Error)
        // The screen builds an empty map on a non-Data result and falls back to the id.
        assertEquals("k1", kinHeading("k1", kinByIdFrom(result)))
    }
}
