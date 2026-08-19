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
 *
 * THE ONE SENTENCE, AND WHY IT IS NOT "ALWAYS ON" (#451). These lines used to
 * read "Always on. Required by Tribe Tails." That is a promise this screen has
 * no standing to make. The catalog's `alwaysEnabled` flag is ADVISORY: ruling #7
 * (2026-06-08, warn-but-allow-off) removed its enforcement, `resolveChannels`
 * has no alwaysEnabled check, and the operator can switch any of those fourteen
 * rows off — after which the notification genuinely stops sending to anyone.
 * The static fallback catalog in `NotificationCatalog.kt`, which renders
 * whenever `getNotificationCatalog` fails, does not even know the operator's
 * current gate, so a household can be sitting in front of "Always on" for a row
 * that is off right now.
 *
 * What IS true at this layer, and all these lines now claim: the household is
 * not the one who decides this channel, and this screen is not where it
 * changes. The admin surfaces say the same thing in their own seat's words
 * ("Meant to stay on" for the advisory flag, "Set by your business" for a
 * channel the recipient cannot change).
 */
/** The one sentence for a channel the household cannot change here. */
internal const val SET_BY_BUSINESS_NOTE = "Set by Tribe Tails Pet Care. Can't be changed here."

/** Channels the kinfolk can actually toggle on this key. */
internal fun NotificationKey.toggleableChannels(): Set<NotificationChannel> =
    allowedChannels - lockedChannels - required

/**
 * True when the key renders chips but none can be changed: every channel on
 * this key is Tribe Tails' call, not the household's.
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
 * so the "All in category" row is replaced by this note. Null when the row
 * should render its chips as usual.
 */
internal fun categorySetByBusinessNote(cat: CategoryDef): String? =
    if (cat.keys.isNotEmpty() && cat.toggleableChannelsInCategory().isEmpty()) {
        SET_BY_BUSINESS_NOTE
    } else {
        null
    }

/**
 * The explanatory line under a key with locked channels:
 *  - the operator's lockReason wins when present (verbatim, trimmed);
 *  - a fully locked key without a reason gets the whole sentence;
 *  - a partial lock without a reason gets the same sentence, naming which
 *    channels it covers;
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
        key.isFullyLocked() -> SET_BY_BUSINESS_NOTE
        else -> "Set by Tribe Tails Pet Care, can't be changed here: ${lockedLabels.joinToString(", ")}"
    }
}

/** Trailing indicator on a channel chip: a check for a catalog-required
 *  channel, a lock for admin-locked. Both mean the same thing from the
 *  household's seat — Tribe Tails decides that channel, not you — which is what
 *  [categoryMarkerLegend] says. Rendered as a real vector icon, never a glyph. */
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
        "A check or a lock means Tribe Tails Pet Care sets that channel; you can't change it here."
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
