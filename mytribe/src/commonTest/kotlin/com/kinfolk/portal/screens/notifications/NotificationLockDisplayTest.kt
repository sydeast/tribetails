package com.kinfolk.portal.screens.notifications

import com.kinfolk.portal.notifications.CategoryDef
import com.kinfolk.portal.notifications.NotificationChannel
import com.kinfolk.portal.notifications.NotificationKey
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Pure lock-display rules for the notification revamp:
 *  - operator lockReason wins over the stock "Set by Tribe Tails Pet Care." line
 *  - a fully locked key (no toggleable channels) gets that stock line, which
 *    names who decides rather than promising "always on" (#451)
 *  - the "All in category" row only offers channels at least one key can
 *    actually toggle (no dead select-all chips over locked keys)
 *  - chip mechanics: a required/admin-locked chip ignores byKey/byCategory
 *    writes and shows what the DISPATCHER resolves for it, which is not always
 *    on (#491).
 */
class NotificationLockDisplayTest {

    private val EMAIL = NotificationChannel.EMAIL
    private val SMS = NotificationChannel.SMS
    private val PUSH = NotificationChannel.PUSH

    private fun key(
        allowed: Set<NotificationChannel>,
        required: Set<NotificationChannel> = emptySet(),
        locked: Set<NotificationChannel> = emptySet(),
        lockedValues: Map<NotificationChannel, Boolean> = emptyMap(),
        lockReason: String? = null,
        keyId: String = "test.key",
    ) = NotificationKey(
        key = keyId,
        title = "Test",
        description = "Test key",
        allowedChannels = allowed,
        required = required,
        lockedChannels = locked,
        lockedChannelValues = lockedValues,
        lockReason = lockReason,
    )

    private fun category(vararg keys: NotificationKey) = CategoryDef(
        id = "cat",
        title = "Cat",
        description = "d",
        keys = keys.toList(),
    )

    // ---- toggleableChannels / isFullyLocked ----

    @Test
    fun toggleable_excludes_locked_and_required_channels() {
        val k = key(allowed = setOf(EMAIL, SMS, PUSH), required = setOf(EMAIL), locked = setOf(SMS))
        assertEquals(setOf(PUSH), k.toggleableChannels())
    }

    @Test
    fun fullyLocked_when_every_allowed_channel_is_locked() {
        val k = key(allowed = setOf(EMAIL, SMS), locked = setOf(EMAIL, SMS))
        assertTrue(k.isFullyLocked())
    }

    @Test
    fun fullyLocked_when_channels_split_between_locked_and_required() {
        val k = key(allowed = setOf(EMAIL, SMS), required = setOf(EMAIL), locked = setOf(SMS))
        assertTrue(k.isFullyLocked())
    }

    @Test
    fun notFullyLocked_when_a_channel_remains_toggleable() {
        val k = key(allowed = setOf(EMAIL, SMS), locked = setOf(SMS))
        assertFalse(k.isFullyLocked())
    }

    @Test
    fun notFullyLocked_when_key_has_no_channels_at_all() {
        assertFalse(key(allowed = emptySet()).isFullyLocked())
    }

    // ---- category "select all" row ----

    @Test
    fun categoryToggleable_is_union_of_key_toggleables() {
        val cat = category(
            key(allowed = setOf(EMAIL, SMS), locked = setOf(SMS), keyId = "a"),
            key(allowed = setOf(SMS, PUSH), keyId = "b"),
        )
        // SMS is locked on key a but toggleable on key b, so it keeps a category chip.
        assertEquals(setOf(EMAIL, SMS, PUSH), cat.toggleableChannelsInCategory())
    }

    @Test
    fun categoryToggleable_drops_channel_locked_on_every_key() {
        val cat = category(
            key(allowed = setOf(EMAIL, SMS), locked = setOf(SMS), keyId = "a"),
            key(allowed = setOf(EMAIL, SMS), locked = setOf(SMS), keyId = "b"),
        )
        assertEquals(setOf(EMAIL), cat.toggleableChannelsInCategory())
    }

    @Test
    fun setByBusinessNote_when_every_key_is_fully_locked() {
        val cat = category(
            key(allowed = setOf(EMAIL), locked = setOf(EMAIL), keyId = "a"),
            key(allowed = setOf(EMAIL, SMS), locked = setOf(EMAIL, SMS), keyId = "b"),
        )
        assertEquals("Set by Tribe Tails Pet Care. Can't be changed here.", categorySetByBusinessNote(cat))
    }

    @Test
    fun noSetByBusinessNote_when_something_is_toggleable() {
        val cat = category(
            key(allowed = setOf(EMAIL), locked = setOf(EMAIL), keyId = "a"),
            key(allowed = setOf(EMAIL), keyId = "b"),
        )
        assertNull(categorySetByBusinessNote(cat))
    }

    @Test
    fun noSetByBusinessNote_for_empty_category() {
        assertNull(categorySetByBusinessNote(category()))
    }

    // ---- lockExplanation ----

    @Test
    fun explanation_null_when_nothing_locked() {
        assertNull(lockExplanation(key(allowed = setOf(EMAIL, SMS))))
        // Required-only keys keep their check chips with no reason line (unchanged).
        assertNull(lockExplanation(key(allowed = setOf(EMAIL), required = setOf(EMAIL))))
    }

    @Test
    fun explanation_prefers_operator_lockReason() {
        val k = key(
            allowed = setOf(EMAIL, SMS, PUSH),
            locked = setOf(SMS),
            lockReason = "We text when your Auntie is en route so nobody misses her arrival.",
        )
        assertEquals(
            "We text when your Auntie is en route so nobody misses her arrival.",
            lockExplanation(k),
        )
    }

    @Test
    fun explanation_falls_back_to_default_line_listing_channels() {
        val k = key(allowed = setOf(EMAIL, SMS, PUSH), locked = setOf(EMAIL, SMS))
        assertEquals(
            "Set by Tribe Tails Pet Care, can't be changed here: Email, SMS",
            lockExplanation(k),
        )
    }

    @Test
    fun explanation_treats_blank_lockReason_as_absent() {
        val k = key(allowed = setOf(EMAIL, SMS, PUSH), locked = setOf(SMS), lockReason = "   ")
        assertEquals(
            "Set by Tribe Tails Pet Care, can't be changed here: SMS",
            lockExplanation(k),
        )
    }

    @Test
    fun explanation_trims_operator_lockReason() {
        val k = key(allowed = setOf(EMAIL, SMS, PUSH), locked = setOf(SMS), lockReason = "  Kept on for safety.  ")
        assertEquals("Kept on for safety.", lockExplanation(k))
    }

    @Test
    fun explanation_fullyLocked_without_reason_names_who_decides() {
        val k = key(allowed = setOf(EMAIL, SMS), locked = setOf(EMAIL, SMS))
        assertEquals(
            "Set by Tribe Tails Pet Care. Can't be changed here.",
            lockExplanation(k),
        )
    }
    /**
     * #451. Every stock line on this screen used to promise "Always on", which
     * the household's layer cannot deliver: the catalog's `alwaysEnabled` flag
     * is advisory (ruling #7, 2026-06-08, warn-but-allow-off — `resolveChannels`
     * never checks it), so Tribe Tails can switch the notification off and it
     * genuinely stops sending. The static fallback catalog does not even know
     * the current gate. So the lines may name WHO decides and say the household
     * cannot change it here; they may not say "always". Operator prose is
     * exempt: a lockReason is the operator's own sentence, shown verbatim.
     */
    @Test
    fun stockLines_never_promise_always_on() {
        val stock = listOfNotNull(
            categorySetByBusinessNote(
                category(key(allowed = setOf(EMAIL), locked = setOf(EMAIL), keyId = "a")),
            ),
            lockExplanation(key(allowed = setOf(EMAIL, SMS), locked = setOf(EMAIL, SMS))),
            lockExplanation(key(allowed = setOf(EMAIL, SMS, PUSH), locked = setOf(EMAIL))),
            categoryMarkerLegend(
                category(key(allowed = setOf(EMAIL), locked = setOf(EMAIL), keyId = "a")),
            ),
        )
        assertEquals(4, stock.size)
        stock.forEach { line ->
            assertFalse(line.contains("always", ignoreCase = true), "still promises always: $line")
            assertTrue(
                line.contains("Tribe Tails Pet Care"),
                "does not name who decides: $line",
            )
        }
    }

    @Test
    fun explanation_fullyLocked_with_reason_shows_reason() {
        val k = key(
            allowed = setOf(EMAIL),
            locked = setOf(EMAIL),
            lockReason = "Booking confirmations always go out so there's never a mix-up.",
        )
        assertEquals(
            "Booking confirmations always go out so there's never a mix-up.",
            lockExplanation(k),
        )
    }

    @Test
    fun explanation_ignores_locked_channels_outside_allowed() {
        // Defensive: never name a channel that isn't rendered.
        assertNull(lockExplanation(key(allowed = setOf(EMAIL), locked = setOf(SMS))))
    }

    // ---- chip mechanics (unchanged behavior, now pure) ----

    @Test
    fun chip_adminLocked_stays_checked_when_category_row_says_off() {
        // The category "select all" writes byCategory=false; a locked chip must not flip.
        val k = key(allowed = setOf(EMAIL, SMS), locked = setOf(SMS))
        val chip = channelChipState(k, SMS, marketingGate = false, perKey = null, perCat = false)
        assertTrue(chip.checked)
        assertTrue(chip.locked)
        // The lock renders as a real icon marker, never a glyph in the label.
        assertEquals("SMS", chip.label)
        assertEquals(ChipMarker.AdminLock, chip.marker)
    }

    @Test
    fun chip_adminLocked_stays_checked_when_perKey_override_says_off() {
        val k = key(allowed = setOf(EMAIL, SMS), locked = setOf(SMS))
        val chip = channelChipState(k, SMS, marketingGate = false, perKey = false, perCat = null)
        assertTrue(chip.checked)
        assertTrue(chip.locked)
    }

    @Test
    fun chip_adminLocked_reads_OFF_when_the_dispatcher_resolves_it_off() {
        // #491, the case every client got wrong. `lockedEnabled` pins the row,
        // the operator never switched sms on, and resolveChannels sends nothing
        // on it. The chip must say off — and stay read-only, because the
        // household still does not decide it.
        val k = key(allowed = setOf(EMAIL, SMS), locked = setOf(EMAIL, SMS),
            lockedValues = mapOf(EMAIL to true, SMS to false))
        val sms = channelChipState(k, SMS, marketingGate = false, perKey = true, perCat = true)
        assertFalse(sms.checked)
        assertTrue(sms.locked)
        assertEquals(ChipMarker.AdminLock, sms.marker)
        // Its sibling on the same locked row is on, so this is not the whole
        // row reading off.
        assertTrue(channelChipState(k, EMAIL, marketingGate = false, perKey = false, perCat = false).checked)
    }
    @Test
    fun chip_locked_without_a_shipped_value_reads_on() {
        // A server that has not shipped lockedChannelValues yet leaves the map
        // empty. On is the right reading there: everything the static fallback
        // catalog locks is catalog-required, and required resolves on.
        val k = key(allowed = setOf(EMAIL, SMS), locked = setOf(SMS))
        assertTrue(channelChipState(k, SMS, marketingGate = false, perKey = false, perCat = false).checked)
    }
    @Test
    fun chip_required_checked_locked_with_check_marker() {
        val k = key(allowed = setOf(EMAIL), required = setOf(EMAIL))
        val chip = channelChipState(k, EMAIL, marketingGate = false, perKey = null, perCat = false)
        assertTrue(chip.checked)
        assertTrue(chip.locked)
        assertEquals("Email", chip.label)
        assertEquals(ChipMarker.RequiredCheck, chip.marker)
    }

    @Test
    fun chip_required_marker_wins_over_lock_marker() {
        val k = key(allowed = setOf(EMAIL), required = setOf(EMAIL), locked = setOf(EMAIL))
        assertEquals(
            ChipMarker.RequiredCheck,
            channelChipState(k, EMAIL, marketingGate = false, perKey = null, perCat = null).marker,
        )
    }

    @Test
    fun chip_unlocked_follows_perKey_then_perCat_then_email_default() {
        val k = key(allowed = setOf(EMAIL, SMS))
        assertFalse(channelChipState(k, EMAIL, marketingGate = false, perKey = false, perCat = true).checked)
        assertTrue(channelChipState(k, SMS, marketingGate = false, perKey = null, perCat = true).checked)
        assertTrue(channelChipState(k, EMAIL, marketingGate = false, perKey = null, perCat = null).checked)
        assertFalse(channelChipState(k, SMS, marketingGate = false, perKey = null, perCat = null).checked)
        assertFalse(channelChipState(k, EMAIL, marketingGate = false, perKey = null, perCat = null).locked)
        assertEquals("Email", channelChipState(k, EMAIL, marketingGate = false, perKey = null, perCat = null).label)
        assertNull(channelChipState(k, EMAIL, marketingGate = false, perKey = null, perCat = null).marker)
    }

    // ---- marker legend ----

    @Test
    fun legend_shown_when_category_has_required_or_locked_channels() {
        // #451: the two markers mean the same thing from the household's seat, so
        // the legend says that once instead of promising one of them is "always on".
        val expected =
            "A check or a lock means Tribe Tails Pet Care sets that channel; you can't change it here."
        val withLock = category(key(allowed = setOf(EMAIL, SMS), locked = setOf(SMS)))
        val withRequired = category(key(allowed = setOf(EMAIL), required = setOf(EMAIL)))
        assertEquals(expected, categoryMarkerLegend(withLock))
        assertEquals(expected, categoryMarkerLegend(withRequired))
    }

    @Test
    fun legend_null_when_nothing_is_marked() {
        assertNull(categoryMarkerLegend(category(key(allowed = setOf(EMAIL, SMS)))))
        // A lock on a channel that isn't rendered doesn't earn a legend either.
        assertNull(categoryMarkerLegend(category(key(allowed = setOf(EMAIL), locked = setOf(SMS)))))
        assertNull(categoryMarkerLegend(category()))
    }

    @Test
    fun chip_marketingGate_locks_without_forcing_checked() {
        val k = key(allowed = setOf(EMAIL))
        val chip = channelChipState(k, EMAIL, marketingGate = true, perKey = false, perCat = null)
        assertFalse(chip.checked)
        assertTrue(chip.locked)
    }

    // ---- channelInheritedChecked (task 27a: revert-to-inherited) ----

    @Test
    fun inheritedChecked_ignoresOwnOverride_fallsBackToPerCatThenEmailDefault() {
        val k = key(allowed = setOf(EMAIL, SMS))
        assertTrue(channelInheritedChecked(k, EMAIL, perCat = true))
        assertFalse(channelInheritedChecked(k, SMS, perCat = false))
        assertTrue(channelInheritedChecked(k, EMAIL, perCat = null)) // email-on default
        assertFalse(channelInheritedChecked(k, SMS, perCat = null))
    }

    @Test
    fun inheritedChecked_stillReadsRequiredAndAdminLockedChannelsAsOn() {
        val required = key(allowed = setOf(EMAIL), required = setOf(EMAIL))
        assertTrue(channelInheritedChecked(required, EMAIL, perCat = false))
        val locked = key(allowed = setOf(SMS), locked = setOf(SMS))
        assertTrue(channelInheritedChecked(locked, SMS, perCat = false))
    }
}
