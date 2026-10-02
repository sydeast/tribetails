package com.kinfolk.portal.error
import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.screens.invoices.InvoicesController
import kotlinx.coroutines.test.runTest
import kotlin.coroutines.cancellation.CancellationException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue
/**
 * #1079: leaving a screen mid-load cancels its LaunchedEffect. A catch-all that
 * swallowed the cancellation set an error banner on a screen nobody is looking
 * at and ran on to the next request.
 */
class RethrowCancellationTest {
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
    @Test fun aCancelledInvoicesLoadSetsNoErrorAndStopsAtTheFirstCall() = runTest {
        val fake = FakeFunctionsClient()
        fake.stubError("getMyInvoices", CancellationException("left composition"))
        val c = InvoicesController("kin-1", PortalApi(fake), this) { }
        assertFailsWith<CancellationException> { c.reload() }
        assertNull(c.error)
        assertEquals(listOf("getMyInvoices"), fake.calls.map { it.first })
    }
    @Test fun aRealInvoicesFailureStillShowsItsMessage() = runTest {
        val fake = FakeFunctionsClient()
        fake.stubError("getMyInvoices", IllegalStateException("boom"))
        fake.stubError("getMyHome", IllegalStateException("boom"))
        fake.stubError("getAccountCreditHistory", IllegalStateException("boom"))
        val c = InvoicesController("kin-1", PortalApi(fake), this) { }
        c.reload()
        assertEquals("boom", c.error)
    }
}
