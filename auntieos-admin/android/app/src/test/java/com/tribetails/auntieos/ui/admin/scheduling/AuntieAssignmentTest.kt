package com.tribetails.auntieos.ui.admin.scheduling

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-JVM tests for the "can this visit be assigned at all" gate. Mirrors web
 * BookingDetailModal's isEnvelopeVisit.
 *
 * Assignment lives on the MyTribe kinCare visit doc at
 * families/{kinfolkId}/bookings/{batchId}/kinCares/{visitId}, so a session that
 * does not carry all three ids has no doc to assign against. Before this, the
 * screen hid the whole section when they were missing, which left an operator
 * unable to tell "nobody is assigned" from "this cannot be assigned".
 */
class AuntieAssignmentTest {

    @Test
    fun `canAssignAuntie true when every envelope id is present`() {
        assertTrue(canAssignAuntie("kf1", "b1", "v1"))
    }

    @Test
    fun `canAssignAuntie false when any single id is missing`() {
        assertFalse(canAssignAuntie("", "b1", "v1"))
        assertFalse(canAssignAuntie("kf1", "", "v1"))
        assertFalse(canAssignAuntie("kf1", "b1", ""))
    }

    @Test
    fun `canAssignAuntie false on null or whitespace ids`() {
        assertFalse(canAssignAuntie(null, "b1", "v1"))
        assertFalse(canAssignAuntie("kf1", null, "v1"))
        assertFalse(canAssignAuntie("kf1", "b1", null))
        assertFalse(canAssignAuntie("  ", "b1", "v1"))
    }

    @Test
    fun `assignUnavailableReason explains why rather than only naming the state`() {
        val reason = assignUnavailableReason()
        assertTrue("must name the booking request", reason.contains("booking request"))
        assertTrue("must say what is missing", reason.contains("visit record"))
        assertFalse("no em dashes in operator copy", reason.contains("—"))
    }
}
