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
    @Test fun aCancelledInvoicesLoadSetsNoErrorAndAsksForNothingAfterIt() = runTest {
        val fake = FakeFunctionsClient()
        fake.stubError("getMyInvoices", CancellationException("left composition"))
        val c = InvoicesController("kin-1", PortalApi(fake), this) { }
        assertFailsWith<CancellationException> { c.reload() }
        assertNull(c.error)
        // #1282: the three reads now START together (they used to be awaited one
        // after the other, two cold starts in a row), so all three are already
        // asked for when the cancellation lands. What #1079 protects still
        // holds: no banner, the cancellation propagates, and nothing is asked
        // for AFTER it (each read exactly once, no retry, no follow-on call).
        assertEquals(
            listOf("getAccountCreditHistory", "getMyHome", "getMyInvoices"),
            fake.calls.map { it.first }.sorted(),
        )
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
