package com.tribetails.auntieos.web.observability
import com.tribetails.auntieos.web.FakeAuntieDataSource
import com.tribetails.auntieos.web.data.ActivityLogEntry
import com.tribetails.auntieos.web.data.AuntieDataSource
import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.screens.booking.BookingViewModel
import kotlinx.coroutines.test.runTest
import kotlin.coroutines.cancellation.CancellationException
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue
/**
 * #1079: a catch-all that swallows a [CancellationException] lets a cancelled
 * coroutine run on to its next suspension point. The helpers every desktop
 * catch-all now goes through must let it propagate, and must leave real
 * failures exactly as they were.
 */
class RethrowCancellationTest {
    private val reported = mutableListOf<Throwable>()
    @AfterTest fun restore() {
        errorSink = ::reportError
    }
    @Test fun runCatchingCancellableRethrowsCancellation() {
        assertFailsWith<CancellationException> {
            runCatchingCancellable { throw CancellationException("left composition") }
        }
    }
    @Test fun runCatchingCancellableStillCapturesARealFailure() {
        val boom = IllegalStateException("real")
        val r = runCatchingCancellable { throw boom }
        assertTrue(r.isFailure)
        assertEquals(boom, r.exceptionOrNull())
    }
    @Test fun rethrowIfCancellationIgnoresWrappersAndPlainErrors() {
        IllegalStateException("real").rethrowIfCancellation()
        RuntimeException("wrapper", CancellationException("inner")).rethrowIfCancellation()
        assertFailsWith<CancellationException> { CancellationException("stop").rethrowIfCancellation() }
    }
    private class CancelsOnAudit(private val inner: AuntieDataSource) : AuntieDataSource by inner {
        override suspend fun logActivity(entry: ActivityLogEntry): WriteResult<String> =
            throw CancellationException("left composition mid audit")
    }
    /** The load path the issue describes: leaving the screen mid-call must stop the coroutine, not be absorbed. */
    @Test fun aCancelledAuditPropagatesAndLeavesNoErrorOrReport() = runTest {
        errorSink = { t, _ -> reported += t }
        val fake = FakeAuntieDataSource()
        fake.emitSessions(FirestoreResult.Data(listOf(KinCareSession(_id = "b1", status = "DRAFT"))))
        val vm = BookingViewModel(CancelsOnAudit(fake))
        assertFailsWith<CancellationException> { vm.approveBooking("b1") }
        assertNull(vm.errorMessage)
        assertTrue(reported.isEmpty())
    }
}
