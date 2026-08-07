package com.kinfolk.portal.screens.notifications

import com.kinfolk.portal.notifications.CategoryDef
import com.kinfolk.portal.notifications.NotificationChannel
import com.kinfolk.portal.notifications.NotificationKey

/**
 * Pure display rules for admin-locked notification channels (notification
 * revamp). Extracted from NotificationSettingsScreen so the lock rendering
 * logic is unit-testable without Compose.
 *
 * Background: the business operator can LOCK a channel on (Run-4 #13), and the
 * revamped `getNotificationCatalog` now also returns always-on keys (booking
 * confirmations, receipts, password reset, ...) with EVERY surviving channel
 * locked plus an optional operator-authored `lockReason`. The dispatcher
 * enforces the same locks server-side; everything here is explanation only.
 */

/** Channels the kinfolk can actually toggle on this key. */
internal fun NotificationKey.toggleableChannels(): Set<NotificationChannel> =
    allowedChannels - lockedChannels - required

/**
 * True when the key renders chips but none can be changed: the notification is
 * always-on for this kinfolk.
 */
internal fun NotificationKey.isFullyLocked(): Boolean =
    allowedChannels.isNotEmpty() && toggleableChannels().isEmpty()

/**
 * Union of toggleable channels across the category's keys. Drives the
 * "All in category" chips: a channel no key can toggle gets no category chip,
 * because that chip would write byCategory with zero visible effect while the
 * locked key chips below stay on (a dead control that contradicts them).
 */
internal fun CategoryDef.toggleableChannelsInCategory(): Set<NotificationChannel> =
    keys.flatMap { it.toggleableChannels() }.toSet()

/**
 * When every key in the category is fully locked there is nothing to select,
 * so the "All in category" row is replaced by this always-on note. Null when
 * the row should render its chips as usual.
 */
internal fun categoryAlwaysOnNote(cat: CategoryDef): String? =
    if (cat.keys.isNotEmpty() && cat.toggleableChannelsInCategory().isEmpty()) {
        "Always on. Required by Tribe Tails."
    } else {
        null
    }

/**
 * The explanatory line under a key with locked channels:
 *  - the operator's lockReason wins when present (verbatim, trimmed);
 *  - a fully locked key without a reason reads clearly as always-on;
 *  - a partial lock without a reason keeps the original default line naming
 *    the locked channels;
 *  - null when nothing is locked (required-only keys keep their check chips
 *    with no line, unchanged).
 *
 * lockedChannels is intersected with allowedChannels defensively so we never
 * explain a channel we don't render.
 */
internal fun lockExplanation(key: NotificationKey): String? {
    val lockedLabels = NotificationChannel.entries
        .filter { it in key.lockedChannels && it in key.allowedChannels }
        .map { it.label }
    if (lockedLabels.isEmpty()) return null
    val reason = key.lockReason?.trim()?.takeUnless { it.isEmpty() }
    return when {
        reason != null -> reason
        key.isFullyLocked() -> "Always on. Required by Tribe Tails (can't be changed here)."
        else -> "Required by Tribe Tails (can't be changed here): ${lockedLabels.joinToString(", ")}"
    }
}

/** Trailing indicator on a channel chip: a check for required (always on),
 *  a lock for admin-locked. Rendered as a real vector icon, never a glyph. */
internal enum class ChipMarker { RequiredCheck, AdminLock }

/** Resolved render state for one per-key channel chip. */
internal data class ChannelChipState(
    val label: String,
    val checked: Boolean,
    val locked: Boolean,
    val marker: ChipMarker? = null,
)

/**
 * One-line legend explaining the chip markers, shown under a category card's
 * header when any rendered channel in the category carries a check or a lock.
 * Null when no key in the category has a marked channel (no legend needed).
 */
internal fun categoryMarkerLegend(cat: CategoryDef): String? {
    val hasMarker = cat.keys.any { k ->
        k.allowedChannels.any { it in k.required || it in k.lockedChannels }
    }
    return if (hasMarker) {
        "A check means always on. A lock means set by Tribe Tails Pet Care."
    } else {
        null
    }
}

/**
 * Chip mechanics, unchanged from Run-4 #13 and now pure: required and
 * admin-locked channels are forced ON no matter what byKey/byCategory writes
 * say (so a category-row "select all" can never flip a locked chip), then the
 * per-key override applies, then the category default, then the email-on
 * default. The required/locked state surfaces as a [ChipMarker] icon.
 */
internal fun channelChipState(
    key: NotificationKey,
    ch: NotificationChannel,
    marketingGate: Boolean,
    perKey: Boolean?,
    perCat: Boolean?,
): ChannelChipState {
    val required = ch in key.required
    val adminLocked = ch in key.lockedChannels
    val checked = when {
        required -> true
        adminLocked -> true
        perKey != null -> perKey
        perCat != null -> perCat
        else -> ch == NotificationChannel.EMAIL
    }
    return ChannelChipState(
        label = ch.label,
        checked = checked,
        locked = required || marketingGate || adminLocked,
        marker = when {
            required -> ChipMarker.RequiredCheck
            adminLocked -> ChipMarker.AdminLock
            else -> null
        },
    )
}

/**
 * Effective checked state for a channel ignoring this key's OWN override —
 * what it would read if the kinfolk had never diverged from the category
 * default (task 27a). PerKeyRow compares a fresh toggle against this value:
 * when they match, the toggle is undoing a prior override rather than
 * creating a new one, and the client clears the entry instead of pinning an
 * explicit duplicate of the value it would have inherited anyway. Delegates
 * to [channelChipState] with `perKey = null` so the required/admin-locked/
 * perCat/email-default precedence stays in exactly one place;
 * `marketingGate` doesn't affect `.checked`, so it's always passed `false`
 * here regardless of the caller's actual gate state.
 */
internal fun channelInheritedChecked(
    key: NotificationKey,
    ch: NotificationChannel,
    perCat: Boolean?,
): Boolean = channelChipState(key = key, ch = ch, marketingGate = false, perKey = null, perCat = perCat).checked
