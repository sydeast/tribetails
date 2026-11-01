package com.kinfolk.portal.portal
import com.kinfolk.portal.firebase.FakeFunctionsClient
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
/** #1303: the three fields a completed visit carries, and an older server's silence reading as none. */
class CompletedVisitLinksPortalApiTest {
    private fun stub(fake: FakeFunctionsClient, withLinks: Boolean) {
        fake.stub("getMyBookings", buildJsonObject {
            put("liveVisit", JsonNull)
            put("upcoming", buildJsonArray {})
            put("recent", buildJsonArray {
                add(buildJsonObject {
                    put("id", "v1")
                    put("kinfolkId", "fam-1")
                    put("status", "completed")
                    put("sessionId", "sess-1")
                    if (withLinks) {
                        put("address", "12 Elm St, Austin TX")
                        put("kinTaleId", "tale-9")
                        put("invoiceId", "inv-3")
                    } else {
                        put("address", JsonNull)
                        put("kinTaleId", "")
                    }
                })
            })
        })
    }
    @Test
    fun `decodes the address, KinTale and invoice`() = runTest {
        val fake = FakeFunctionsClient()
        stub(fake, withLinks = true)
        val b = PortalApi(fake).getMyBookings("fam-1").recent.single()
        assertEquals("12 Elm St, Austin TX", b.address)
        assertEquals("tale-9", b.kinTaleId)
        assertEquals("inv-3", b.invoiceId)
    }
    @Test
    fun `null, blank and missing all read as nothing to link`() = runTest {
        val fake = FakeFunctionsClient()
        stub(fake, withLinks = false)
        val b = PortalApi(fake).getMyBookings("fam-1").recent.single()
        assertNull(b.address)
        assertNull(b.kinTaleId)
        assertNull(b.invoiceId)
    }
    @Test
    fun `a completed and a cancelled visit are finished, a confirmed one is not`() {
        fun b(s: BookingStatus) = Booking("v", "f", s, null, null, null, null, emptyList(), emptyList(), null, null, null, null, null)
        assertTrue(b(BookingStatus.Completed).isFinished())
        assertTrue(b(BookingStatus.Cancelled).isFinished())
        assertTrue(!b(BookingStatus.Confirmed).isFinished())
    }
}
