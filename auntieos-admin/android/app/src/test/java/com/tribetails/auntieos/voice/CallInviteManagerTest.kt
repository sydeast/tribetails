package com.tribetails.auntieos.voice

import android.content.Context
import com.twilio.voice.CallInvite
import com.twilio.voice.CancelledCallInvite
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

/**
 * CallInviteManager had no callers for onCallInvite / onCancelledCallInvite, so
 * activeInvite was permanently null and answer()/reject() returned doing nothing.
 * These pin the state machine now that AuntieFirebaseMessagingService feeds it.
 *
 * The manager is an object, so every test seeds its own invite and tearDown
 * clears it rather than relying on a fresh instance.
 */
class CallInviteManagerTest {

    private val context: Context = mockk(relaxed = true)

    private fun invite(callSid: String): CallInvite = mockk(relaxed = true) {
        every { this@mockk.callSid } returns callSid
        every { from } returns "+15551234567"
    }

    private fun cancelled(callSid: String): CancelledCallInvite = mockk(relaxed = true) {
        every { this@mockk.callSid } returns callSid
    }

    @After
    fun tearDown() {
        // Drops any invite the test left behind so the next test starts clean.
        CallInviteManager.reject(mockk(relaxed = true))
    }

    @Test
    fun an_incoming_invite_moves_the_state_to_ringing() {
        CallInviteManager.onCallInvite(invite("CA_ring"))

        assertEquals(
            CallInviteManager.VoiceCallState.Ringing,
            CallInviteManager.voiceCallState.value
        )
    }

    @Test
    fun rejecting_a_live_invite_rejects_it_on_the_sdk_and_ends_the_call() {
        val callInvite = invite("CA_reject")
        CallInviteManager.onCallInvite(callInvite)

        CallInviteManager.reject(context)

        verify(exactly = 1) { callInvite.reject(context) }
        assertEquals(
            CallInviteManager.VoiceCallState.Ended,
            CallInviteManager.voiceCallState.value
        )
    }

    @Test
    fun rejecting_twice_only_touches_the_sdk_once() {
        val callInvite = invite("CA_reject_twice")
        CallInviteManager.onCallInvite(callInvite)

        CallInviteManager.reject(context)
        CallInviteManager.reject(context)

        verify(exactly = 1) { callInvite.reject(context) }
    }

    @Test
    fun a_cancellation_for_the_live_invite_ends_the_call() {
        CallInviteManager.onCallInvite(invite("CA_cancel"))

        CallInviteManager.onCancelledCallInvite(cancelled("CA_cancel"))

        assertEquals(
            CallInviteManager.VoiceCallState.Ended,
            CallInviteManager.voiceCallState.value
        )
    }

    @Test
    fun a_cancellation_for_a_different_call_leaves_the_live_invite_ringing() {
        CallInviteManager.onCallInvite(invite("CA_live"))

        CallInviteManager.onCancelledCallInvite(cancelled("CA_someone_else"))

        assertEquals(
            CallInviteManager.VoiceCallState.Ringing,
            CallInviteManager.voiceCallState.value
        )
    }

    @Test
    fun a_second_invite_replaces_the_first_as_the_one_reject_acts_on() {
        val first = invite("CA_first")
        val second = invite("CA_second")
        CallInviteManager.onCallInvite(first)
        CallInviteManager.onCallInvite(second)

        CallInviteManager.reject(context)

        verify(exactly = 1) { second.reject(context) }
        verify(exactly = 0) { first.reject(context) }
    }

    @Test
    fun rejecting_with_no_invite_is_a_harmless_no_op() {
        CallInviteManager.reject(context)
        val stateAfterFirst = CallInviteManager.voiceCallState.value

        CallInviteManager.reject(context)

        assertSame(stateAfterFirst, CallInviteManager.voiceCallState.value)
    }
}
