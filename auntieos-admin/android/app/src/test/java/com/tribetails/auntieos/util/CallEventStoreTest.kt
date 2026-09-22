package com.tribetails.auntieos.util

import com.tribetails.auntieos.data.model.CallEvent
import org.junit.After
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #893 item 5: `CallEventStore` is a JVM-wide singleton `object`, so state one
 * test's `addEvent` leaves behind is still there for the next test in the same
 * run. `reset()` is the test-only escape hatch; this file proves it actually
 * clears both flows.
 */
class CallEventStoreTest {

    @After
    fun tearDown() {
        CallEventStore.reset()
    }

    @Test
    fun `reset clears every event and the active call`() {
        CallEventStore.addEvent(CallEvent(callSid = "CA893reset", callerNumber = "+18055550100", transcript = "", popupUrl = ""))
        assertTrue(CallEventStore.events.value.isNotEmpty())
        assertTrue(CallEventStore.activeCall.value != null)

        CallEventStore.reset()

        assertTrue(CallEventStore.events.value.isEmpty())
        assertNull(CallEventStore.activeCall.value)
    }
}
