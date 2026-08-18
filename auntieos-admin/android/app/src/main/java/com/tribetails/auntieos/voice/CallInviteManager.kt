package com.tribetails.auntieos.voice

import android.content.Context
import android.util.Log
import com.twilio.voice.Call
import com.twilio.voice.CallException
import com.twilio.voice.CallInvite
import com.twilio.voice.CancelledCallInvite
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

object CallInviteManager {

    private const val TAG = "CallInviteManager"

    sealed class VoiceCallState {
        object Idle      : VoiceCallState()
        object Ringing   : VoiceCallState()
        object Connected : VoiceCallState()
        object Ended     : VoiceCallState()
    }

    private val _voiceCallState = MutableStateFlow<VoiceCallState>(VoiceCallState.Idle)
    val voiceCallState: StateFlow<VoiceCallState> = _voiceCallState.asStateFlow()

    private val _isMuted = MutableStateFlow(false)
    val isMuted: StateFlow<Boolean> = _isMuted.asStateFlow()

    /**
     * Legacy boolean kept for any caller still reading isSpeakerOn.
     * Derived from currentRoute.value == AudioRoute.Speaker.
     * Do not write directly - write via setRoute() / setSpeakerphone() shim.
     */
    private val _isSpeakerOn = MutableStateFlow(false)
    val isSpeakerOn: StateFlow<Boolean> = _isSpeakerOn.asStateFlow()

    private var activeInvite: CallInvite? = null
    private var activeCall: Call? = null

    // ── AudioRouter wiring ────────────────────────────────────────────────
    // Lazily initialized on first answer(); cleared on hangUp().
    private var router: AudioRouter? = null

    private val defaultRouteFlow: StateFlow<AudioRoute> =
        MutableStateFlow(AudioRoute.Earpiece).asStateFlow()
    private val defaultErrorFlow: StateFlow<String?> =
        MutableStateFlow<String?>(null).asStateFlow()

    val currentRoute: StateFlow<AudioRoute>
        get() = router?.currentRoute ?: defaultRouteFlow
    val audioRouteError: StateFlow<String?>
        get() = router?.audioRouteError ?: defaultErrorFlow

    private fun ensureRouter(context: Context): AudioRouter {
        val existing = router
        if (existing != null) return existing
        val fresh = AudioRouter.create(context)
        router = fresh
        return fresh
    }

    fun onCallInvite(callInvite: CallInvite) {
        activeInvite = callInvite
        _voiceCallState.value = VoiceCallState.Ringing
        Log.d(TAG, "Call invite received from ${callInvite.from}")
    }

    fun onCancelledCallInvite(cancelled: CancelledCallInvite) {
        if (activeInvite?.callSid == cancelled.callSid) {
            activeInvite = null
            _voiceCallState.value = VoiceCallState.Ended
            Log.d(TAG, "Call invite cancelled")
        }
    }

    fun answer(context: Context) {
        val invite = activeInvite ?: return
        activeCall = invite.accept(context, callListener)
        activeInvite = null
        _isMuted.value = false
        // Sync the route StateFlow from the actual system state instead of
        // hard-resetting to Earpiece. If the user already had a BT headset
        // connected, the UI should reflect that.
        val r = ensureRouter(context)
        r.syncFromSystem()
        _isSpeakerOn.value = (r.currentRoute.value == AudioRoute.Speaker)
        _voiceCallState.value = VoiceCallState.Connected
        Log.d(TAG, "Call answered")
    }

    fun reject(context: Context) {
        activeInvite?.reject(context)
        activeInvite = null
        _voiceCallState.value = VoiceCallState.Ended
        Log.d(TAG, "Call rejected")
    }

    fun hangUp() {
        activeCall?.disconnect()
        activeCall = null
        _voiceCallState.value = VoiceCallState.Ended
        endAudioSession()
        Log.d(TAG, "Call hung up")
    }

    /**
     * Hands the audio hardware back at the end of a call, whoever ended it.
     *
     * On API 26-30 a Bluetooth call holds an open SCO link and a changed audio
     * mode, and neither goes away by itself: leaving them behind wedges the next
     * call, and any media playback, on a headset the user did not choose.
     *
     * The router INSTANCE is still retained on purpose - clearing it would race
     * with observers reading currentRoute on the way down - but its session is
     * released so nothing outlives the call.
     */
    private fun endAudioSession() {
        router?.release()
        _isSpeakerOn.value = false
    }

    fun setMuted(muted: Boolean) {
        activeCall?.mute(muted)
        _isMuted.value = muted
    }

    /**
     * Preferred API. Delegates to AudioRouter.
     */
    fun setRoute(context: Context, route: AudioRoute): Boolean {
        val r = ensureRouter(context)
        val ok = r.setRoute(route)
        _isSpeakerOn.value = (r.currentRoute.value == AudioRoute.Speaker)
        return ok
    }

    /**
     * Returns the routes the user can currently select. Reads through to
     * AudioRouter; safe to call before answer() (returns a default pair).
     */
    fun availableRoutes(context: Context): Set<AudioRoute> =
        ensureRouter(context).availableRoutes()

    fun clearAudioRouteError() {
        router?.clearError()
    }

    /**
     * Deprecated shim. Maps the old boolean to the new 3-state API.
     * Keeps any future caller compiling - will be removed once we're sure
     * nothing outside CallsViewModel calls this.
     */
    @Deprecated(
        message = "Use setRoute(context, AudioRoute) for 3-state audio routing",
        replaceWith = ReplaceWith("setRoute(context, if (on) AudioRoute.Speaker else AudioRoute.Earpiece)")
    )
    fun setSpeakerphone(context: Context, on: Boolean) {
        setRoute(context, if (on) AudioRoute.Speaker else AudioRoute.Earpiece)
    }

    private val callListener = object : Call.Listener {
        override fun onConnected(call: Call) {
            activeCall = call
            _voiceCallState.value = VoiceCallState.Connected
            Log.d(TAG, "Call connected")
        }

        override fun onDisconnected(call: Call, callException: CallException?) {
            activeCall = null
            _voiceCallState.value = VoiceCallState.Ended
            // The far end can hang up too; that path has to unwedge the audio
            // just as hangUp() does.
            endAudioSession()
            Log.d(TAG, "Call disconnected: ${callException?.message}")
        }

        override fun onConnectFailure(call: Call, callException: CallException) {
            activeCall = null
            _voiceCallState.value = VoiceCallState.Ended
            endAudioSession()
            Log.e(TAG, "Call connect failure: ${callException.message}")
        }

        override fun onRinging(call: Call) {}
        override fun onReconnecting(call: Call, callException: CallException) {}
        override fun onReconnected(call: Call) {}
    }
}
