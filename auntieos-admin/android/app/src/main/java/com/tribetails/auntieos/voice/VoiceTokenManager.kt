package com.tribetails.auntieos.voice

import android.content.Context
import com.google.firebase.messaging.FirebaseMessaging
import com.tribetails.auntieos.data.api.TwilioApi
import com.tribetails.auntieos.util.AuntieLog
import com.tribetails.auntieos.util.fcmTokenFlow
import com.tribetails.auntieos.util.saveFcmToken
import com.twilio.voice.RegistrationException
import com.twilio.voice.RegistrationListener
import com.twilio.voice.Voice
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await

object VoiceTokenManager {

    private var cachedToken: String? = null

    fun initialize(context: Context, twilioApi: TwilioApi, scope: CoroutineScope) {
        AuntieLog.d("Initializing VoiceTokenManager")
        scope.launch { fetchAndRegister(context, twilioApi) }
    }

    fun onFcmTokenRefresh(context: Context, twilioApi: TwilioApi, newFcmToken: String, scope: CoroutineScope) {
        AuntieLog.i("FCM token refreshed, re-registering voice")
        scope.launch {
            val token = cachedToken ?: fetchToken(twilioApi) ?: return@launch
            register(token, newFcmToken)
        }
    }

    private suspend fun fetchAndRegister(context: Context, twilioApi: TwilioApi) {
        val token = fetchToken(twilioApi) ?: return
        var fcmToken = context.fcmTokenFlow().first()
        if (fcmToken.isBlank()) {
            try {
                AuntieLog.d("Fetching FCM token from Firebase")
                fcmToken = FirebaseMessaging.getInstance().token.await()
                context.saveFcmToken(fcmToken)
                AuntieLog.d("FCM token fetched and saved")
            } catch (e: Exception) {
                AuntieLog.e("Could not get FCM token from Firebase", e)
            }
        }
        if (fcmToken.isNotBlank()) {
            register(token, fcmToken)
        } else {
            AuntieLog.w("Cannot register voice: FCM token is blank")
        }
    }

    private suspend fun fetchToken(twilioApi: TwilioApi): String? {
        return try {
            AuntieLog.d("Fetching Twilio access token")
            twilioApi.getToken().token.also { 
                cachedToken = it 
                AuntieLog.d("Twilio token fetched successfully")
            }
        } catch (e: Exception) {
            AuntieLog.e("Twilio token fetch failed", e)
            null
        }
    }

    private fun register(accessToken: String, fcmToken: String) {
        AuntieLog.d("Registering Voice SDK with FCM token")
        Voice.register(accessToken, Voice.RegistrationChannel.FCM, fcmToken, object : RegistrationListener {
            override fun onRegistered(accessToken: String, fcmToken: String) {
                AuntieLog.i("Voice SDK registered successfully")
            }
            override fun onError(error: RegistrationException, accessToken: String, fcmToken: String) {
                AuntieLog.e("Voice SDK registration error: ${error.message}", error)
            }
        })
    }
}
