package com.tribetails.auntieos.fcm

import android.app.NotificationManager
import android.content.Context
import com.google.firebase.messaging.RemoteMessage
import com.tribetails.auntieos.ui.calls.CallScreenActivity
import com.twilio.voice.MessageListener
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ServiceController
import org.robolectric.annotation.Config

/**
 * Covers the FCM entry point that was never wired: a genuine Twilio Voice SDK
 * push has to reach Voice.handleMessage or the app can never ring. The custom
 * `call_invite` push is a separate payload and has to keep working alongside it.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class AuntieFirebaseMessagingServiceTest {

    private lateinit var controller: ServiceController<AuntieFirebaseMessagingService>
    private lateinit var service: AuntieFirebaseMessagingService
    private lateinit var notificationManager: NotificationManager

    /** The production seam, restored after every test. */
    private val realVoiceHandler = AuntieFirebaseMessagingService.voiceMessageHandler

    /** Payloads the fake Voice SDK handler was given. */
    private val handledPayloads = mutableListOf<Map<String, String>>()
    private var handledListener: MessageListener? = null

    @Before
    fun setUp() {
        controller = Robolectric.buildService(AuntieFirebaseMessagingService::class.java).create()
        service = controller.get()
        notificationManager = service.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        AuntieFirebaseMessagingService.voiceMessageHandler = { _, data, listener ->
            handledPayloads += data
            handledListener = listener
            true
        }
    }

    @After
    fun tearDown() {
        AuntieFirebaseMessagingService.voiceMessageHandler = realVoiceHandler
        notificationManager.cancelAll()
        controller.destroy()
    }

    private fun push(data: Map<String, String>): RemoteMessage =
        RemoteMessage.Builder("auntieos@fcm.googleapis.com")
            .apply { data.forEach { (k, v) -> addData(k, v) } }
            .build()

    private fun customCallInvitePush(callSid: String) = push(
        mapOf(
            "type" to "call_invite",
            "callSid" to callSid,
            "callerNumber" to "+15551234567",
            "transcript" to "Calling about a booking"
        )
    )

    // ── Twilio Voice SDK push ────────────────────────────────────────────

    @Test
    fun sdk_push_is_routed_to_voice_handle_message() {
        service.onMessageReceived(
            push(
                mapOf(
                    "twi_message_type" to "twilio.voice.call",
                    "twi_call_sid" to "CA0000000000000000000000000000001",
                    "twi_from" to "+15551234567"
                )
            )
        )

        assertEquals(1, handledPayloads.size)
        assertEquals("twilio.voice.call", handledPayloads[0]["twi_message_type"])
        assertEquals("CA0000000000000000000000000000001", handledPayloads[0]["twi_call_sid"])
    }

    @Test
    fun sdk_push_supplies_a_message_listener_so_invites_can_reach_the_manager() {
        service.onMessageReceived(push(mapOf("twi_message_type" to "twilio.voice.call")))

        assertNotNull(
            "Voice.handleMessage must be given a MessageListener, otherwise the parsed " +
                "CallInvite is dropped and answer()/reject() stay no-ops",
            handledListener
        )
    }

    @Test
    fun sdk_push_does_not_raise_the_screening_notification() {
        service.onMessageReceived(push(mapOf("twi_message_type" to "twilio.voice.call")))

        assertEquals(0, shadowOf(notificationManager).size())
    }

    @Test
    fun sdk_push_wins_even_when_the_payload_also_carries_our_type_key() {
        // Defensive: if a payload ever carried both, Twilio's key decides.
        service.onMessageReceived(
            push(mapOf("twi_message_type" to "twilio.voice.call", "type" to "call_invite"))
        )

        assertEquals(1, handledPayloads.size)
        assertEquals(0, shadowOf(notificationManager).size())
    }

    @Test
    fun sdk_push_that_the_sdk_rejects_does_not_crash_or_fall_through() {
        AuntieFirebaseMessagingService.voiceMessageHandler = { _, _, _ -> false }

        service.onMessageReceived(push(mapOf("twi_message_type" to "twilio.voice.cancel")))

        assertEquals(0, shadowOf(notificationManager).size())
    }

    @Test
    fun sdk_push_survives_the_sdk_throwing() {
        AuntieFirebaseMessagingService.voiceMessageHandler = { _, _, _ ->
            throw IllegalStateException("native layer unavailable")
        }

        service.onMessageReceived(push(mapOf("twi_message_type" to "twilio.voice.call")))

        assertEquals(0, shadowOf(notificationManager).size())
    }

    // ── Custom call_invite push (our backend, screening UI) ──────────────

    @Test
    fun custom_call_invite_push_raises_the_screening_intent() {
        service.onMessageReceived(customCallInvitePush("CA_screen_1"))

        assertEquals(0, handledPayloads.size)
        assertEquals(1, shadowOf(notificationManager).size())

        val notification = notificationManager.activeNotifications.single().notification
        val fullScreen = notification.fullScreenIntent
        assertNotNull("call_invite must post a full-screen intent", fullScreen)

        val launched = shadowOf(fullScreen).savedIntent
        assertEquals(
            CallScreenActivity::class.java.name,
            launched.component?.className
        )
        assertEquals(
            "CA_screen_1",
            launched.getStringExtra(AuntieFirebaseMessagingService.EXTRA_CALL_SID)
        )
        assertEquals(
            "+15551234567",
            launched.getStringExtra(AuntieFirebaseMessagingService.EXTRA_CALLER_NUMBER)
        )
        assertEquals(
            "Calling about a booking",
            launched.getStringExtra(AuntieFirebaseMessagingService.EXTRA_TRANSCRIPT)
        )
    }

    // ── Notification id collision ────────────────────────────────────────

    @Test
    fun two_concurrent_calls_get_distinct_notification_ids() {
        service.onMessageReceived(customCallInvitePush("CA_first"))
        service.onMessageReceived(customCallInvitePush("CA_second"))

        val ids = notificationManager.activeNotifications.map { it.id }.toSet()
        assertEquals("second call must not overwrite the first", 2, ids.size)
        assertEquals(2, shadowOf(notificationManager).size())
    }

    @Test
    fun two_concurrent_calls_keep_their_own_screening_extras() {
        service.onMessageReceived(customCallInvitePush("CA_first"))
        service.onMessageReceived(customCallInvitePush("CA_second"))

        val sids = notificationManager.activeNotifications.map {
            shadowOf(it.notification.fullScreenIntent).savedIntent
                .getStringExtra(AuntieFirebaseMessagingService.EXTRA_CALL_SID)
        }.toSet()

        assertEquals(setOf("CA_first", "CA_second"), sids)
    }

    @Test
    fun the_same_call_arriving_twice_reuses_one_notification() {
        service.onMessageReceived(customCallInvitePush("CA_same"))
        service.onMessageReceived(customCallInvitePush("CA_same"))

        assertEquals(1, shadowOf(notificationManager).size())
    }

    @Test
    fun call_notification_ids_never_reach_the_slots_the_siblings_own() {
        // SMS/voicemail/booking/callback sit at 2001-2004 and the catalog range
        // tops out at 68535. A call id must be above all of them.
        listOf(null, "", "CA_a", "CA_b", "CA_zzzzzzzzzzzzzzzzzzzz").forEach { sid ->
            val id = AuntieFirebaseMessagingService.callNotificationId(sid)
            assertTrue(
                "id $id for sid $sid collides with a reserved slot",
                id >= AuntieFirebaseMessagingService.NOTIFICATION_ID_CALL_BASE
            )
        }
        assertNotEquals(
            AuntieFirebaseMessagingService.callNotificationId("CA_a"),
            AuntieFirebaseMessagingService.callNotificationId("CA_b")
        )
    }

    // ── Everything else ──────────────────────────────────────────────────

    @Test
    fun unknown_type_is_logged_not_crashed() {
        service.onMessageReceived(push(mapOf("type" to "something_we_never_shipped")))

        assertEquals(0, shadowOf(notificationManager).size())
        assertEquals(0, handledPayloads.size)
    }

    @Test
    fun payload_with_no_keys_at_all_is_survivable() {
        service.onMessageReceived(push(emptyMap()))

        assertEquals(0, shadowOf(notificationManager).size())
        assertEquals(0, handledPayloads.size)
    }

    @Test
    fun existing_sms_route_still_works() {
        service.onMessageReceived(
            push(mapOf("type" to "sms_inbound", "from" to "+15550001111", "body" to "hello"))
        )

        assertEquals(1, shadowOf(notificationManager).size())
        assertEquals(0, handledPayloads.size)
    }

    @Test
    fun is_voice_sdk_push_keys_off_twi_message_type_only() {
        assertTrue(
            AuntieFirebaseMessagingService.isVoiceSdkPush(mapOf("twi_message_type" to "twilio.voice.call"))
        )
        assertTrue(
            AuntieFirebaseMessagingService.isVoiceSdkPush(mapOf("twi_message_type" to ""))
        )
        assertEquals(
            false,
            AuntieFirebaseMessagingService.isVoiceSdkPush(mapOf("type" to "call_invite"))
        )
    }
}
