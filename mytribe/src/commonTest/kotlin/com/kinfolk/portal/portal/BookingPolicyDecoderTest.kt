package com.kinfolk.portal.portal
import com.kinfolk.portal.firebase.FakeFunctionsClient
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
/** `PortalApi.getBookingPolicy` decode, including #1092's `startTimeServiceIds`. */
class BookingPolicyDecoderTest {
    private fun policyJson(withStartTimeIds: Boolean, blocks: Boolean = true) = buildJsonObject {
        put("allowTimeBlockBooking", true)
        put("allowSpecificTimeBooking", false)
        put("defaultBookingMode", "TIME_BLOCK")
        putJsonArray("timeBlocks") {
            if (blocks) {
                add(
                    buildJsonObject {
                        put("id", "midday")
                        put("label", "Midday")
                        put("startTime", "11:00")
                        put("endTime", "15:00")
                        put("durationMinutes", 240)
                    },
                )
            }
        }
        if (withStartTimeIds) {
            putJsonArray("startTimeServiceIds") {
                add("Overnight")
                add("")
                add(JsonNull)
                add("Overnight")
            }
        }
    }
    private suspend fun decode(json: kotlinx.serialization.json.JsonObject): BookingPolicy {
        val fake = FakeFunctionsClient()
        fake.stub("getBookingPolicy", json)
        return PortalApi(fake).getBookingPolicy()
    }
    @Test
    fun `an older server without startTimeServiceIds decodes to none`() = runTest {
        val p = decode(policyJson(withStartTimeIds = false))
        assertEquals(emptySet(), p.startTimeServiceIds)
        assertTrue(p.allowTimeBlockBooking)
        assertEquals(BookingMode.TimeBlock, p.defaultBookingMode)
    }
    @Test
    fun `reads startTimeServiceIds when present, dropping blanks`() = runTest {
        val p = decode(policyJson(withStartTimeIds = true))
        assertEquals(setOf("Overnight"), p.startTimeServiceIds)
    }
    @Test
    fun `still renormalizes block booking off when no window decodes`() = runTest {
        val p = decode(policyJson(withStartTimeIds = true, blocks = false))
        assertFalse(p.allowTimeBlockBooking)
        assertTrue(p.allowSpecificTimeBooking)
        assertEquals(setOf("Overnight"), p.startTimeServiceIds)
    }
    @Test
    fun `the clock-only fallback carries no start-time KinCares`() {
        assertEquals(emptySet(), BookingPolicy.CLOCK_ONLY.startTimeServiceIds)
    }
}
