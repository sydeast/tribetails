package com.tribetails.auntieos.web

import com.tribetails.auntieos.web.data.decodeImportedCount
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFails

/**
 * Slice 8: unit coverage for the syncGoogleCalendarBusyEvents response decoder
 * used by FirestoreClient.syncGoogleCalendarBusyEvents on web Wasm + desktop JVM.
 */
class CalendarSyncDecodeTest {

    @Test
    fun decodesImportedCount() {
        assertEquals(3, decodeImportedCount("""{"imported":3,"scanned":3}"""))
    }

    @Test
    fun decodesZeroWhenEmptyImport() {
        assertEquals(0, decodeImportedCount("""{"imported":0,"scanned":0}"""))
    }

    @Test
    fun missingImportedFieldDefaultsToZeroNoFabrication() {
        assertEquals(0, decodeImportedCount("""{"scanned":5}"""))
    }

    @Test
    fun malformedJsonThrowsSoCallerMapsToErr() {
        assertFails { decodeImportedCount("not-json{") }
    }
}
