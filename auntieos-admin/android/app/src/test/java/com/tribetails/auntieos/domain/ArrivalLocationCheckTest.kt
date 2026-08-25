package com.tribetails.auntieos.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ISSUE #582: what the phone says to the Auntie about an arrival it has already
 * recorded.
 *
 * Every case here is one she can find herself in on a real morning, and the
 * thing being pinned is that only ONE of them tells her something is wrong.
 * A verification that shouts on every arrival gets dismissed on every arrival,
 * including the one that mattered.
 */
class ArrivalLocationCheckTest {

    private fun outcome(
        status: ArrivalCheckStatus,
        distanceMeters: Double? = null,
        radiusMeters: Int = 150,
        verificationRequired: Boolean = true,
    ) = ArrivalCheckOutcome(status, distanceMeters, radiusMeters, verificationRequired)

    // ── decoding ──────────────────────────────────────────────────────────────

    @Test
    fun `each server verdict decodes to its own status`() {
        assertEquals(ArrivalCheckStatus.WITHIN, ArrivalCheckStatus.fromWire("within"))
        assertEquals(ArrivalCheckStatus.OUTSIDE, ArrivalCheckStatus.fromWire("outside"))
        assertEquals(ArrivalCheckStatus.UNVERIFIED, ArrivalCheckStatus.fromWire("unverified"))
        assertEquals(
            ArrivalCheckStatus.HOUSEHOLD_LOCATION_UNKNOWN,
            ArrivalCheckStatus.fromWire("household_location_unknown"),
        )
    }

    /**
     * A phone that has not been updated must not start telling the Auntie a
     * visit is fine, nor that she is in the wrong place, on the strength of a
     * word it does not know. Unknown falls to "could not verify".
     */
    @Test
    fun `an unrecognised verdict falls to unverified, never to a pass or a refusal`() {
        assertEquals(ArrivalCheckStatus.UNVERIFIED, ArrivalCheckStatus.fromWire("some_new_verdict"))
        assertEquals(ArrivalCheckStatus.UNVERIFIED, ArrivalCheckStatus.fromWire(null))
        assertEquals(ArrivalCheckStatus.UNVERIFIED, ArrivalCheckStatus.fromWire(""))
    }

    @Test
    fun `decoding tolerates the casing and padding a wire value might arrive with`() {
        assertEquals(ArrivalCheckStatus.OUTSIDE, ArrivalCheckStatus.fromWire("  OUTSIDE "))
    }

    // ── what she is told ──────────────────────────────────────────────────────

    /**
     * The happy path says NOTHING. The arrival is already on the card, and a
     * "you are where you said you were" banner after every single arrival is
     * noise that trains people to dismiss the one that matters.
     */
    @Test
    fun `a verified arrival says nothing at all`() {
        assertNull(arrivalCheckNotice(outcome(ArrivalCheckStatus.WITHIN, distanceMeters = 30.0)))
    }

    @Test
    fun `an arrival outside the radius names the distance, the radius, and the consequence`() {
        val msg = arrivalCheckNotice(outcome(ArrivalCheckStatus.OUTSIDE, distanceMeters = 2400.0))
        assertNotNull(msg)
        assertTrue(msg!!, msg.contains("2.4 km"))
        assertTrue(msg, msg.contains("150 m"))
        assertTrue(msg, msg.contains("cannot be marked complete"))
    }

    /**
     * The two "we could not check" cases must say the visit is FINE, because it
     * is: the server completes a visit with no location evidence. An Auntie told
     * otherwise starts doing something pointless about it.
     */
    @Test
    fun `a fix too rough to use says the visit can still be completed`() {
        val msg = arrivalCheckNotice(outcome(ArrivalCheckStatus.UNVERIFIED))
        assertNotNull(msg)
        assertTrue(msg!!, msg.contains("can still be completed"))
        assertTrue(msg, msg.contains("unverified"))
    }

    @Test
    fun `a household we cannot place on a map says the visit can still be completed`() {
        val msg = arrivalCheckNotice(outcome(ArrivalCheckStatus.HOUSEHOLD_LOCATION_UNKNOWN))
        assertNotNull(msg)
        assertTrue(msg!!, msg.contains("can still be completed"))
        assertTrue(msg, msg.contains("no map location"))
    }

    @Test
    fun `no fix at all says the visit can still be completed`() {
        val msg = arrivalNoFixNotice(verificationRequired = true)
        assertNotNull(msg)
        assertTrue(msg!!, msg.contains("can still be completed"))
        assertTrue(msg, msg.contains("unverified"))
    }

    /**
     * With verification off, nothing the check found can stop anything, so
     * reporting a distance would be reporting a rule that does not exist.
     */
    @Test
    fun `nothing is said at all when the operator has verification switched off`() {
        assertNull(arrivalCheckNotice(outcome(ArrivalCheckStatus.OUTSIDE, 2400.0, verificationRequired = false)))
        assertNull(arrivalCheckNotice(outcome(ArrivalCheckStatus.UNVERIFIED, verificationRequired = false)))
        assertNull(
            arrivalCheckNotice(
                outcome(ArrivalCheckStatus.HOUSEHOLD_LOCATION_UNKNOWN, verificationRequired = false),
            ),
        )
        assertNull(arrivalNoFixNotice(verificationRequired = false))
    }

    @Test
    fun `no outcome says nothing`() {
        assertNull(arrivalCheckNotice(null))
    }

    /** The operator's radius is echoed by the server, so the message quotes theirs, not ours. */
    @Test
    fun `the message quotes the operator radius rather than a hardcoded one`() {
        val msg = arrivalCheckNotice(outcome(ArrivalCheckStatus.OUTSIDE, 900.0, radiusMeters = 400))
        assertTrue(msg!!, msg.contains("400 m"))
    }

    @Test
    fun `an outside verdict with no distance still says something useful`() {
        val msg = arrivalCheckNotice(outcome(ArrivalCheckStatus.OUTSIDE, distanceMeters = null))
        assertNotNull(msg)
        assertTrue(msg!!, msg.contains("a long way"))
    }

    // ── formatting ────────────────────────────────────────────────────────────

    @Test
    fun `distances read in metres below a kilometre and kilometres above`() {
        assertEquals("44 m", formatArrivalDistance(43.6))
        assertEquals("1.2 km", formatArrivalDistance(1234.0))
        assertEquals("150 m", formatArrivalDistance(150.0))
    }
}
