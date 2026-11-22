package com.kinfolk.portal.screens.schedule

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse

/** #1835: the live card read "Waiting for first GPS ping" and then "N pings · live". */
class LiveRouteLineTest {
    @Test
    fun beforeTheFirstPointItSaysWhatWillShow() {
        assertEquals("The route shows here as your Auntie moves.", liveRouteLine(0))
    }

    @Test
    fun onceTheRouteIsDrawingItSaysLiveRouteWithNoCount() {
        assertEquals("Live route", liveRouteLine(1))
        assertEquals("Live route", liveRouteLine(240))
    }

    @Test
    fun neverTechWords() {
        listOf(0, 1, 5).forEach { n ->
            val line = liveRouteLine(n).lowercase()
            assertFalse("ping" in line, line)
            assertFalse("gps" in line, line)
        }
    }
}
