package com.tribetails.auntieos.web.data

import com.tribetails.auntieos.web.screens.schedule.blockedSlotsByDate
import com.tribetails.auntieos.web.screens.schedule.busyPlacement
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull

/**
 * #1160: a 14:00 to 15:00 Chicago Google busy event, exactly as
 * `busyIntervalToSlots` writes it (pinned in
 * `mytribe/functions/test/googleBusySlot.test.ts`), decodes through the desktop
 * REST codec with its extra `startMs`/`endMs`/`timeZone` keys and draws on the
 * 14:00 row of its business day. Before #1160 the row stored 19:00 to 20:00.
 */
class GoogleBusySlotDrawTest {

    private val row = """
        {"_id":"gbi-1","date":"2026-10-05","startTime":"14:00","endTime":"15:00",
         "startMs":1791226800000,"endMs":1791230400000,"timeZone":"America/Chicago",
         "isAvailable":false,"slotType":"BLOCKED","notes":"Imported busy event",
         "source":"GOOGLE_BUSY_IMPORT","externalEventId":"busy_cal_1791226800000_1791230400000",
         "externalCalendarId":"cal","hideDetailsFromKinfolk":true,"isEditableByAdmin":true,
         "isRemovableByAdmin":true,"syncState":"SYNCED","createdAt":"2026-10-01T00:00:00.000Z"}
    """.trimIndent()

    @Test
    fun aChicagoBusyImportDrawsOnTheFourteenHundredRow() {
        val slot = JvmFirestoreRest.codec.decodeFromString(BookingTimeSlot.serializer(), row)
        val grouped = blockedSlotsByDate(listOf(slot))
        assertEquals(listOf("gbi-1"), grouped["2026-10-05"]?.map { it._id })
        val placement = assertNotNull(busyPlacement(slot.startTime, slot.endTime))
        // The grid opens at 08:00, so 14:00 is six hours down.
        assertEquals(6 * 60, placement.topMinutes)
        assertEquals(60, placement.heightMinutes)
    }
}
