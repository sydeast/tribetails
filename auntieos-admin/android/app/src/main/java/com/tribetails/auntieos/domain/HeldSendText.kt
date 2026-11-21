package com.tribetails.auntieos.domain

/**
 * #1834 (operator ruling, 2026-11-20): what the owner reads when a broadcast or
 * a marketing blast is held because notices to households are switched off, or
 * because that notice is turned off in Settings.
 *
 * The server refuses with one of three tokens (`sendSwitchRules.ts`) and has
 * sent and stored nothing, so nothing goes out later. Same sentences as the web
 * (`heldSendText.ts`) and the desktop console.
 */
enum class HeldSendKind { Broadcast, Blast }

private const val SWITCH_NAME = "\"Send notices to households\" in Settings, under Notifications"

/** Every held sentence starts with this, so a screen can draw it as a hold rather than a failure. */
const val HELD_SEND_PREFIX = "Held."

/** The owner's sentence for a held send, or null when [message] is not a hold. Pure. */
fun heldSendText(message: String, kind: HeldSendKind): String? {
    val sent = if (kind == HeldSendKind.Broadcast) "This broadcast was not sent" else "This blast was not scheduled"
    val again = if (kind == HeldSendKind.Broadcast) "send it again" else "schedule it again"
    return when {
        message.contains("held_household_notices_off") ->
            "Held. Notices to households are switched off. $sent and will not go out later. " +
                "To send it, switch on $SWITCH_NAME, then $again."
        message.contains("held_notice_turned_off") -> {
            val what = if (kind == HeldSendKind.Broadcast) "Broadcasts are" else "This campaign is"
            "Held. $what turned off in Settings, under Notifications. $sent and will not go out later."
        }
        message.contains("held_household_notices_unreadable") ->
            "Held. The setting for notices to households could not be read. $sent. Try again in a minute."
        else -> null
    }
}

/**
 * A campaign row's counts. `dispatched` counts every copy queued; the ones held
 * at the send time never went, so they are taken out of "sent" and named. Pure.
 */
fun blastCountsText(dispatched: Int, suppressed: Int, heldAtSend: Int): String {
    val held = heldAtSend.coerceAtLeast(0)
    val sent = (dispatched - held).coerceAtLeast(0)
    return "$sent sent, ${suppressed.coerceAtLeast(0)} suppressed" + if (held == 0) "" else ", $held held and not sent"
}
