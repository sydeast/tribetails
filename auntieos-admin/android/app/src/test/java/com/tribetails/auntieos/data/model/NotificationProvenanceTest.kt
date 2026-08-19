package com.tribetails.auntieos.data.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #396: the Android half of "who receives it, what fires it, whether it got
 * out", plus the honesty fix on `alwaysEnabled`.
 *
 * The "Always on" caption on the gate matrix was a lie. Nothing in
 * `resolveChannels` checks `alwaysEnabled` — ruling #7, 2026-06-08,
 * warn-but-allow-off — so 14 catalog rows, password reset among them, could be
 * switched off from a screen that captioned them as protected. This suite is
 * what stops the caption coming back, on this client as well as on web.
 */
class NotificationProvenanceTest {

    private fun entry(
        alwaysEnabled: Boolean = false,
        alwaysEnabledStreams: Set<String> = emptySet(),
        neverFires: Boolean = false,
        external: Boolean = false,
        marketingCategory: String? = null,
        whoReceives: List<String> = emptyList(),
        allowedChannels: List<String> = listOf("email", "sms", "push"),
        templates: Map<String, String> = emptyMap(),
        mergeFields: List<String> = emptyList(),
        emitters: List<NotificationEmitter> = emptyList(),
        emailTemplateRetargetedFrom: String? = null,
    ) = NotificationCatalogEntry(
        key = "invoice.new",
        label = "New invoice",
        audience = "both",
        allowedChannels = allowedChannels,
        alwaysEnabled = alwaysEnabled,
        alwaysEnabledStreams = alwaysEnabledStreams,
        marketingCategory = marketingCategory,
        whoReceives = whoReceives,
        emitters = emitters,
        neverFires = neverFires,
        templates = templates,
        mergeFields = mergeFields,
        external = external,
        emailTemplateRetargetedFrom = emailTemplateRetargetedFrom,
    )

    // ── alwaysEnabled: advisory, and said so ────────────────────────────────

    @Test
    fun noBadgeOnARowWithoutTheFlag() {
        assertNull(notifAlwaysOnBadge(entry(), STREAM_BUSINESS, enabled = true))
    }

    @Test
    fun neverUsesTheWordsAlwaysOn() {
        val badge = notifAlwaysOnBadge(entry(alwaysEnabled = true), STREAM_BUSINESS, enabled = true)!!
        assertFalse(badge.label.equals("Always on", ignoreCase = true))
        assertTrue(badge.detail.contains("you can switch it off"))
    }

    @Test
    fun escalatesToAWarningOnceTheRowIsActuallyOff() {
        val critical = entry(alwaysEnabled = true)
        assertEquals(
            NotifBadgeTone.Info,
            notifAlwaysOnBadge(critical, STREAM_BUSINESS, enabled = true)!!.tone,
        )
        val off = notifAlwaysOnBadge(critical, STREAM_BUSINESS, enabled = false)!!
        assertEquals(NotifBadgeTone.Warn, off.tone)
        assertTrue(off.detail.contains("not sent to anyone"))
    }

    /**
     * #451: the gate matrix and `AdminNotificationPrefsScreen` render the
     * advisory flag with the SAME words, from the same two constants, so the
     * operator cannot get one answer on one screen and another on the next.
     * "Meant to stay on" is deliberately not "Required" and not "Always on":
     * those are promises the flag cannot keep, since `resolveChannels` never
     * checks it (ruling #7, warn-but-allow-off).
     */
    @Test
    fun theAdvisoryBadgeUsesTheOneSharedVocabulary() {
        val critical = entry(alwaysEnabled = true)
        assertEquals(
            NOTIF_MEANT_TO_STAY_ON,
            notifAlwaysOnBadge(critical, STREAM_BUSINESS, enabled = true)!!.label,
        )
        assertEquals(
            NOTIF_OFF_AND_MEANT_TO_STAY_ON,
            notifAlwaysOnBadge(critical, STREAM_BUSINESS, enabled = false)!!.label,
        )
        listOf(NOTIF_MEANT_TO_STAY_ON, NOTIF_OFF_AND_MEANT_TO_STAY_ON).forEach { label ->
            assertFalse(label, label.contains("required", ignoreCase = true))
            assertFalse(label, label.contains("always on", ignoreCase = true))
        }
    }
    @Test
    fun respectsAlwaysEnabledStreamsScoping() {
        val scoped = entry(alwaysEnabled = true, alwaysEnabledStreams = setOf(STREAM_KINFOLK))
        assertTrue(notifAlwaysOnBadge(scoped, STREAM_KINFOLK, true) != null)
        assertNull(notifAlwaysOnBadge(scoped, STREAM_BUSINESS, true))
    }

    /**
     * The model helper is allowed to keep its name, but the gate must never
     * disable the On/Off toggle off it: web lets the operator turn these rows
     * off, and an Android build that refused would give the same operator two
     * contradictory answers on two devices.
     */
    @Test
    fun enabledLockedIsAdvisoryAndDoesNotChangeWhatTheGateCanDo() {
        assertTrue(entry(alwaysEnabled = true).enabledLocked())
        // The row still renders a badge rather than a lock, which is the whole point.
        val badges = notifRowBadges(entry(alwaysEnabled = true), STREAM_BUSINESS, enabled = true)
        assertEquals(listOf("Meant to stay on"), badges.map { it.label })
    }

    // ── the other risk markers ──────────────────────────────────────────────

    @Test
    fun marksARowNothingFires() {
        val badges = notifRowBadges(entry(neverFires = true), STREAM_BUSINESS, enabled = true)
        assertTrue(badges.any { it.label == "Never fires" && it.tone == NotifBadgeTone.Warn })
    }

    @Test
    fun marksARowAnOutsideSystemDelivers() {
        val badges = notifRowBadges(entry(external = true), STREAM_BUSINESS, enabled = true)
        assertTrue(badges.any { it.label == "Sent by another system" })
    }

    @Test
    fun marksMarketingAndSaysTheOptInIsNotOverridable() {
        val badges = notifRowBadges(entry(marketingCategory = "newsletter"), STREAM_BUSINESS, true)
        assertTrue(badges.first { it.label == "Marketing" }.detail.contains("opted in"))
    }

    @Test
    fun aPlainRowCarriesNoBadges() {
        assertEquals(emptyList<NotifRowBadge>(), notifRowBadges(entry(), STREAM_BUSINESS, true))
    }

    // ── who receives it ─────────────────────────────────────────────────────

    private val businessRow = entry(
        whoReceives = listOf("Every business admin on the roster, one copy each."),
    )

    @Test
    fun appendsTheLiveRosterSize() {
        assertTrue(
            notifRecipientLines(businessRow, 3, "businessSettings/admins.uids")[0]
                .contains("3 people"),
        )
    }

    @Test
    fun saysOnePersonNotOnePeople() {
        assertTrue(
            notifRecipientLines(businessRow, 1, "businessSettings/admins.uids")[0]
                .contains("1 person today"),
        )
    }

    @Test
    fun reportsAnUnreadableRosterAsUnknownNeverAsZero() {
        val line = notifRecipientLines(businessRow, null, "businessSettings/admins.uids")[0]
        assertTrue(line.contains("unknown"))
        assertFalse(line.contains("0 people"))
    }

    @Test
    fun saysWhereAnEmptyRosterActuallySends() {
        assertTrue(
            notifRecipientLines(businessRow, 0, "businessSettings/admins.uids")[0]
                .contains("operator allowlist"),
        )
    }

    @Test
    fun leavesAHouseholdSentenceAlone() {
        val row = entry(whoReceives = listOf("The household's own portal account."))
        assertEquals(
            listOf("The household's own portal account."),
            notifRecipientLines(row, 3, "x"),
        )
    }

    // ── templates and merge fields ──────────────────────────────────────────

    @Test
    fun buildsTheTemplatePathPerChannel() {
        val row = entry(
            allowedChannels = listOf("email", "sms"),
            templates = mapOf("email" to "invoice.new", "sms" to "invoice.new"),
        )
        assertEquals(
            listOf("emailTemplates/invoice.new", "smsTemplates/invoice.new"),
            notifTemplateLines(row).map { it.path },
        )
    }

    @Test
    fun flagsAChannelOfferedWithNothingToRenderIt() {
        val row = entry(allowedChannels = listOf("email", "push"), templates = mapOf("email" to "a"))
        assertTrue(notifTemplateLines(row).first { it.channel == "push" }.missing)
    }

    /**
     * The gate can retarget an email as data, with no deploy. Showing the new
     * id without saying it moved reads as though the catalog default were still
     * in play. SMS and push consult no bindings, so they never carry the note.
     */
    @Test
    fun saysWhenEmailHasBeenRetargetedOffTheCatalogDefault() {
        val row = entry(
            allowedChannels = listOf("email", "sms"),
            templates = mapOf("email" to "invoice.new.v2", "sms" to "invoice.new"),
            emailTemplateRetargetedFrom = "invoice.new",
        )
        val lines = notifTemplateLines(row)
        assertEquals("emailTemplates/invoice.new.v2", lines[0].path)
        assertEquals("invoice.new", lines[0].retargetedFrom)
        assertNull(lines[1].retargetedFrom)
    }
    @Test
    fun saysNothingAboutRetargetingOnAnUntouchedRow() {
        val row = entry(allowedChannels = listOf("email"), templates = mapOf("email" to "invoice.new"))
        assertNull(notifTemplateLines(row)[0].retargetedFrom)
    }
    @Test
    fun neverInventsALineForAChannelTheRowDoesNotOffer() {
        val row = entry(allowedChannels = listOf("email"), templates = mapOf("email" to "a", "sms" to "b"))
        assertEquals(listOf("email"), notifTemplateLines(row).map { it.channel })
    }

    @Test
    fun unionsMergeFieldsWithEveryEmitterDataKey() {
        val row = entry(
            mergeFields = listOf("amount", "kinfolkName"),
            emitters = listOf(
                NotificationEmitter("x", "src/a.ts", listOf("invoiceId", "amount")),
                NotificationEmitter("y", "src/b.ts", listOf("stripeEventId")),
            ),
        )
        assertEquals(
            listOf("amount", "invoiceId", "kinfolkName", "stripeEventId"),
            notifMergeFieldNames(row),
        )
    }

    // ── delivery evidence wording ───────────────────────────────────────────

    @Test
    fun callsASuccessfulSendHandedOverNotDelivered() {
        val phrase = notifDeliveryPhrase("sent", null, null)
        assertFalse(phrase.label.contains("Delivered", ignoreCase = true))
        assertTrue(phrase.detail.contains("not proof it arrived"))
    }

    @Test
    fun carriesTheSkipReasonAndTheFailureText() {
        assertTrue(notifDeliveryPhrase("skipped", "no-email-on-file", null).detail.contains("no-email-on-file"))
        assertTrue(notifDeliveryPhrase("failed", null, "Twilio 21610").detail.contains("Twilio 21610"))
    }

    @Test
    fun saysSoWhenNoReasonWasRecordedAtAll() {
        assertTrue(notifDeliveryPhrase("skipped", null, null).detail.contains("no reason was recorded"))
        assertTrue(notifDeliveryPhrase("failed", null, null).detail.contains("no message recorded"))
    }

    @Test
    fun reportsAStatuslessRecordAsUnknownRatherThanAssumingItWent() {
        val phrase = notifDeliveryPhrase("", null, null)
        assertEquals("Unknown", phrase.label)
        assertEquals(NotifDeliveryTone.Warn, phrase.tone)
    }

    @Test
    fun treatsPendingAsWaitingNotAsAFailure() {
        assertEquals(NotifDeliveryTone.Neutral, notifDeliveryPhrase("pending", null, null).tone)
    }
}
