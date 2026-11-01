package com.kinfolk.portal.portal
import com.kinfolk.portal.firebase.FakeFunctionsClient
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
/**
 * #1281: the reschedule and cancellation asks now return the visit as the
 * server stored it, so the detail screen shows it at once instead of sitting
 * through a second read. An older server sends no `visit`, and that is null,
 * never a crash.
 */
class PostSaveVisitPortalApiTest {
    private val storedVisit = buildJsonObject {
        put("id", "v1")
        put("kinfolkId", "fam-1")
        put("status", "confirmed")
        put("batchId", "batch-1")
        put("startTimeMs", 1_786_980_600_000L)
        put("rescheduleRequestStatus", "pending")
        put("rescheduleRequestedStartTimeMs", 1_787_058_000_000L)
        put("cancelRequested", true)
        put("cancelRequestStatus", "pending")
    }
    @Test
    fun `a reschedule reply carries the stored visit`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("requestBookingReschedule", buildJsonObject {
            put("ok", true); put("visitId", "v1"); put("proposedStartTimeMs", 1_787_058_000_000L)
            put("visit", storedVisit)
        })
        val res = PortalApi(fake).requestBookingReschedule("batch-1", "v1", 1_787_058_000_000L, kinfolkId = "fam-1")
        assertEquals("v1", res.visit?.id)
        assertEquals(RescheduleRequestStatus.Pending, res.visit?.rescheduleRequestStatus)
        assertEquals(1_787_058_000_000L, res.visit?.rescheduleRequestedStartTimeMs)
    }
    @Test
    fun `a cancellation reply carries the stored visit`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("requestBookingCancellation", buildJsonObject {
            put("ok", true); put("visitId", "v1"); put("alreadyPending", false)
            put("visit", storedVisit)
        })
        val res = PortalApi(fake).requestBookingCancellation("batch-1", "v1", kinfolkId = "fam-1")
        assertEquals(true, res.visit?.cancelRequested)
        assertEquals(CancelRequestStatus.Pending, res.visit?.cancelRequestStatus)
    }
    @Test
    fun `an older server with no visit decodes to null`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("requestBookingCancellation", buildJsonObject {
            put("ok", true); put("visitId", "v1"); put("alreadyPending", true)
        })
        assertNull(PortalApi(fake).requestBookingCancellation("batch-1", "v1").visit)
    }
}
