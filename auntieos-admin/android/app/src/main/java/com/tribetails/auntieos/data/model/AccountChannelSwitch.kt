package com.tribetails.auntieos.data.model

/**
 * The Account screen's ONE switch per channel, over the same
 * `staff/{uid}.notificationPrefs` store the full My Notifications screen edits
 * row by row. Port of `channelMasterCount` / `channelMasterOn` /
 * `applyChannelToggle` in `auntieos-admin/src/lib/myNotificationsEdit.ts`
 * (#719 on web, #755 sweep here).
 *
 * There is no global "email on" bit in the store: the prefs are per
 * notification (`byKey`), with a `byCategory` fallback and a catalog default.
 * So one switch has to stand for many rows, and this is the reading that does
 * not lie to the operator: ON when at least one notification would currently
 * reach them on this channel. Turning it off silences the channel (every
 * editable row goes off); turning it back on restores every editable row.
 * Anything narrower ("all of them are on") would report OFF while mail kept
 * arriving.
 *
 * Forced channels are excluded on purpose. The business gate decides those
 * and the full page renders them read-only, so counting them here would pin
 * the switch on and make it look broken when tapped.
 */

/** One stream's visible rows, paired with the stream that scopes their gate lookup. */
data class ChannelSwitchScope(
    val entries: List<NotificationCatalogEntry>,
    val stream: String,
)

/**
 * The two hats the operator wears, with the notifications each one can
 * currently receive: the entry serves that stream, the stream's gate is on and
 * at least one channel is offered. The same rows the full page sections.
 */
fun NotificationMatrix.accountChannelScopes(): List<ChannelSwitchScope> =
    listOf(STREAM_BUSINESS, STREAM_STAFF).map { stream ->
        ChannelSwitchScope(catalog.filter { it.adminReceives(this, stream) }, stream)
    }

/**
 * Every (notification, stream) pair whose [channel] the operator may actually
 * decide: the gate offers that channel on that stream and it is not forced on.
 * Exactly the pairs a row toggle on the full page would let them tap, narrowed
 * to one channel. Shared by the three functions below so the switch can never
 * claim to control a pair that its own flip would skip.
 */
private fun NotificationMatrix.editableEntries(
    scopes: List<ChannelSwitchScope>,
    channel: String,
): List<NotificationCatalogEntry> =
    scopes.flatMap { (entries, stream) ->
        entries.filter { entry ->
            channelOfferedToUser(entry, channel, stream) && !channelForcedForUser(entry, channel, stream)
        }
    }

/** How many notifications one channel switch on the Account screen governs. */
fun NotificationMatrix.channelMasterCount(scopes: List<ChannelSwitchScope>, channel: String): Int =
    editableEntries(scopes, channel).size

/** Where the switch sits: on when at least one editable row reaches the operator on [channel]. */
fun AdminNotificationPrefs.channelMasterOn(
    matrix: NotificationMatrix,
    scopes: List<ChannelSwitchScope>,
    channel: String,
): Boolean =
    matrix.editableEntries(scopes, channel).any { effectiveReceive(it, channel) }

/**
 * The write half of [channelMasterOn]: flips ONE channel on every editable
 * (notification, stream) pair, leaving the other two channels exactly where the
 * operator left them. [applyBulkToggle] cannot be reused here because it flips
 * every offered channel at once, which would turn an "SMS off" tap into a
 * silent wipe of the email choices beside it.
 */
fun AdminNotificationPrefs.applyChannelToggle(
    matrix: NotificationMatrix,
    scopes: List<ChannelSwitchScope>,
    channel: String,
    on: Boolean,
): AdminNotificationPrefs {
    var next = this
    matrix.editableEntries(scopes, channel).forEach { entry ->
        next = next.withByKeyChannel(entry.key, channel, on)
    }
    return next
}
