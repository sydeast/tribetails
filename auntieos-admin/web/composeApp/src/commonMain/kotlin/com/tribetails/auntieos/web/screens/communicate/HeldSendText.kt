package com.tribetails.auntieos.web.screens.communicate

/**
 * #1834 (operator ruling, 2026-11-20): what the owner reads when a broadcast is
 * held because notices to households are switched off, or because broadcasts
 * are turned off in Settings.
 *
 * The server refuses with one of three tokens (`sendSwitchRules.ts`) and has
 * sent and stored nothing, so nothing goes out later. Same sentences as the web
 * (`heldSendText.ts`) and Android (`HeldSendText.kt`). The desktop console has
 * no marketing blast screen, so only the broadcast wording is here.
 */
private const val SWITCH_NAME = "\"Send notices to households\" in Settings, under Notifications"

/** Every held sentence starts with this, so the screen can draw it as a hold rather than a failure. */
const val HELD_SEND_PREFIX = "Held."

/** The owner's sentence for a held broadcast, or null when [message] is not a hold. Pure. */
fun heldBroadcastText(message: String): String? = when {
    message.contains("held_household_notices_off") ->
        "Held. Notices to households are switched off. This broadcast was not sent and will not go out later. " +
            "To send it, switch on $SWITCH_NAME, then send it again."
    message.contains("held_notice_turned_off") ->
        "Held. Broadcasts are turned off in Settings, under Notifications. This broadcast was not sent and will not go out later."
    message.contains("held_household_notices_unreadable") ->
        "Held. The setting for notices to households could not be read. This broadcast was not sent. Try again in a minute."
    else -> null
}
