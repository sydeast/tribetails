package com.tribetails.auntieos.fcm

/**
 * Pure helpers that produce user-facing notification titles for FCM events.
 * Kept top-level so they can be unit-tested without instantiating the
 * FirebaseMessagingService (which would require Android framework).
 */
object FcmTitleHelper {

    /**
     * "[Personal] New Voicemail from <from>" when line == "personal".
     * "New Voicemail from <from>" otherwise (business line / unspecified).
     */
    fun voicemailTitle(from: String, line: String?): String {
        val base = "New Voicemail from $from"
        return if (line == "personal") "[Personal] $base" else base
    }

    /**
     * "[Personal] Callback from <number>" when line == "personal".
     * "Callback from <number>" otherwise.
     */
    fun callbackRequestTitle(callerNumber: String, line: String?): String {
        val base = "Callback from $callerNumber"
        return if (line == "personal") "[Personal] $base" else base
    }
}
