package com.tribetails.auntieos.data.model

import com.tribetails.auntieos.ui.admin.humanizeKey

/**
 * Android mirror of `auntieos-admin/src/lib/notificationProvenance.ts` (#396).
 *
 * The SENTENCES are not here. Who a notification reaches and what fires it are
 * written once, server-side, in
 * `mytribe/functions/src/notifications/provenance.ts`, and both clients render
 * the same strings. Two hand-maintained enum→prose maps would drift and the
 * operator would get two different answers on two devices about the same
 * notification, which is the exact failure #396 is about.
 *
 * What lives here is the Android-side framing: the risk badges, the roster
 * count, and the honest wording for a delivery attempt.
 */

/**
 * The channel order every notification surface shares. Declared here rather
 * than borrowed from the settings screen's private list, so the pure model
 * functions below stay usable (and testable) without pulling in Compose.
 */
val NOTIF_CHANNEL_ORDER: List<String> = listOf("email", "sms", "push")
/** Tone for a gate-row badge. `Warn` is the one worth seeing across the room. */
enum class NotifBadgeTone { Warn, Info }

/** A short marker on a gate row, plus the sentence that actually explains it. */
data class NotifRowBadge(
    val label: String,
    val detail: String,
    val tone: NotifBadgeTone,
)

/**
 * THE ONE VOCABULARY FOR THE CATALOG'S ADVISORY FLAG (#451).
 *
 * Three surfaces used to have three words for "this one is important": the
 * gate said "Always on", `AdminNotificationPrefsScreen` showed a "Required"
 * lock pill, and the kinfolk portal said "Always on. Required by Tribe Tails."
 * All three implied a guarantee, and they sat at different layers. These two
 * constants are the admin-side half of the settlement: wherever the catalog's
 * `alwaysEnabled` flag is shown to anyone it is shown with these words and no
 * lock icon, because the flag is advice and not a lock. The recipient-side
 * half is [NOTIF_CHANNEL_SET_BY_BUSINESS] in `NotificationMatrix.kt`, which
 * names WHO decides rather than promising the notification keeps arriving.
 * Mirrors MEANT_TO_STAY_ON / OFF_AND_MEANT_TO_STAY_ON in
 * `auntieos-admin/src/lib/notificationProvenance.ts`.
 */
const val NOTIF_MEANT_TO_STAY_ON = "Meant to stay on"
const val NOTIF_OFF_AND_MEANT_TO_STAY_ON = "Off, and meant to stay on"
/**
 * WHY THIS EXISTS, AND WHY IT IS NOT THE WORDS "ALWAYS ON".
 *
 * The gate matrix captioned an `alwaysEnabled` row "Always on". It is not.
 * `resolveChannels` in MyTribe functions has no alwaysEnabled check anywhere,
 * and the save handler dropped its enforcement in ruling #7 (2026-06-08)
 * deliberately: warn-but-allow-off, the operator stays in control of their own
 * business notifications. Fourteen catalog rows carry the flag, password reset
 * among them, and every one of them can be switched off from this screen and
 * will then genuinely stop sending.
 *
 * So the caption promised a protection the platform does not provide, on the
 * one screen whose whole job is telling the truth about what gets sent. #396
 * offered two ways out: enforce the flag at send time, or stop implying it.
 * Enforcing it would silently reverse a documented operator ruling and take
 * back control the operator asked for. Telling the truth costs nothing, and it
 * builds the warning #7 said the UI would show and which was never built.
 *
 * Hence a RISK MARKER, not a lock: on a row still switched on it reads as
 * "meant to stay on"; on a row already switched off it escalates to a warning.
 */
fun notifAlwaysOnBadge(
    entry: NotificationCatalogEntry,
    stream: String,
    enabled: Boolean,
): NotifRowBadge? {
    if (!entry.alwaysEnabledFor(stream)) return null
    return if (!enabled) {
        NotifRowBadge(
            label = NOTIF_OFF_AND_MEANT_TO_STAY_ON,
            detail = "The catalog marks this one too important to silence, and it is switched off " +
                "anyway. Nothing in the sending code overrides you: while it is off, this " +
                "notification is not sent to anyone.",
            tone = NotifBadgeTone.Warn,
        )
    } else {
        NotifRowBadge(
            label = NOTIF_MEANT_TO_STAY_ON,
            detail = "The catalog marks this one too important to silence. That is advice, not " +
                "a lock: you can switch it off here, and it will stop sending.",
            tone = NotifBadgeTone.Info,
        )
    }
}

/** Every badge a gate row should carry, in the order they should read. */
fun notifRowBadges(
    entry: NotificationCatalogEntry,
    stream: String,
    enabled: Boolean,
): List<NotifRowBadge> = buildList {
    notifAlwaysOnBadge(entry, stream, enabled)?.let { add(it) }
    if (entry.neverFires) {
        add(
            NotifRowBadge(
                label = "Never fires",
                detail = "No code anywhere dispatches this notification, so nothing on this row " +
                    "changes what anyone receives. It is a catalog entry with templates and " +
                    "toggles and no trigger.",
                tone = NotifBadgeTone.Warn,
            ),
        )
    }
    if (entry.external) {
        add(
            NotifRowBadge(
                label = "Sent directly",
                detail = "Sent outside the notification system, so these switches control nothing. " +
                    "Its template still applies.",
                tone = NotifBadgeTone.Warn,
            ),
        )
    }
    entry.marketingCategory?.takeIf { it.isNotBlank() }?.let { category ->
        add(
            NotifRowBadge(
                label = "Marketing",
                detail = "Marketing class ($category). It only sends to people who have opted in, " +
                    "and that opt-in is a legal gate you cannot override from here.",
                tone = NotifBadgeTone.Info,
            ),
        )
    }
}

/**
 * Who this notification reaches, as sentences.
 *
 * A `businessAdmins` line gets the roster size appended, because "every
 * business admin" is a different answer at three people than at fifteen and the
 * operator asking whether something could leak needs the number. A null count
 * is rendered as unreadable, never as zero.
 */
fun notifRecipientLines(
    entry: NotificationCatalogEntry,
    businessAdminCount: Int?,
): List<String> = entry.whoReceives.map { sentence ->
    when {
        !sentence.contains("business admin") -> sentence
        businessAdminCount == null ->
            // #1592: the roster is named, never its database path.
            "$sentence The roster could not be read just now, so the number is unknown."
        businessAdminCount == 0 ->
            "$sentence Nobody is on that roster right now, so sends fall back to the operator allowlist."
        businessAdminCount == 1 -> "$sentence That is 1 person today."
        else -> "$sentence That is $businessAdminCount people today."
    }
}

/**
 * True when this row's recipients include the business admin roster, and so
 * when the gate should offer to name them (issue #450).
 *
 * Reads the resolver fields rather than searching [NotificationCatalogEntry.whoReceives]
 * for the words "business admin". Those sentences are server-authored prose for
 * a human to read; matching on them would make a reworded sentence silently
 * stop offering the roster, and `recipientResolver` is what the dispatcher
 * itself branches on.
 */
fun notifReachesBusinessAdmins(entry: NotificationCatalogEntry): Boolean =
    entry.recipientResolver == "businessAdmins" || entry.secondaryResolver == "businessAdmins"
/**
 * One line per person on the roster: their name, how the mail reaches them, and
 * anything the operator would otherwise have to already know.
 *
 * A uid with no `staff/{uid}` record says so and shows the uid. That member is
 * NOT dropped: they receive every business notification, and a list that hides
 * them under-reports the audience, which is the failure this panel exists to
 * end.
 */
fun businessAdminLines(roster: BusinessAdminRoster): List<String> = roster.members.map { member ->
    // #1564: no per-person address. Every business email goes to the business
    // contact email (operator ruling, 2026-11-05 docket); [businessEmailLine]
    // says where.
    val name = member.displayName ?: member.uid
    val parts = buildList {
        if (!member.hasStaffRecord) add("no staff record for ${member.uid}")
        if (member.defaultAssignee) add("unassigned visits default to them")
    }
    if (parts.isEmpty()) name else "$name (${parts.joinToString("; ")})"
}
/**
 * Where a business row's emails go (#1564): the business contact email, or,
 * while that is blank, nowhere. Same words as the web panel.
 */
fun businessEmailLine(roster: BusinessAdminRoster): String =
    if (roster.businessEmail.isNotBlank()) {
        "Emails go to the business email, ${roster.businessEmail}."
    } else {
        BUSINESS_EMAIL_NOWHERE_LINE
    }

const val BUSINESS_EMAIL_NOWHERE_LINE =
    "Business emails have nowhere to go: the business email in Settings > Business is blank, " +
        "so each one is skipped until it is filled."
/** The email channel's skip reason when `businessEmail` is blank (#1564). */
const val BUSINESS_EMAIL_UNSET = "business_email_unset"
/** The warning beside the Settings email field while it is blank (#1564). Null once filled. */
fun businessEmailNotice(value: String): String? =
    if (value.isBlank()) {
        "Business emails have nowhere to go until this is filled. " +
            "Every business notification email goes to this address."
    } else {
        null
    }
/**
 * The caveat above that list, when there is one.
 *
 * [BusinessAdminRosterSource.OperatorAllowlist] is the state where the stored
 * roster is empty and sends fall back to `AUNTIE_OPERATOR_UIDS`. Those people
 * would still receive the next business notification, so the list is real, but
 * the operator should know the roster itself is empty.
 */
fun businessAdminSourceNote(roster: BusinessAdminRoster): String? {
    if (roster.source != BusinessAdminRosterSource.OperatorAllowlist) return null
    // #1592: no database path and no function name in what the operator reads.
    return "The business admin roster is empty, so these are the operator allowlist accounts " +
        "the next business notification would fall back to."
}
/** One "channel -> template" line for a channel the row offers. */
data class NotifTemplateLine(
    val channel: String,
    /**
     * The template in words (#1592: it was the database path `emailTemplates/<id>`).
     * The row's own template carries the row's own name; another id reads as words.
     */
    val name: String,
    /** True when the row offers this channel with nothing to render it. */
    val missing: Boolean,
    /**
     * The catalog default this channel was moved off, when an operator has
     * retargeted it. Email only: it is the one channel `sendFromTemplate`
     * resolves through `notificationTemplateBindings`, and the only retargeting
     * the gate can do without a deploy.
     */
    val retargetedFrom: String? = null,
)

/** A template id as the operator reads it: the row's own name, or the id as words. */
fun notifTemplateName(id: String, entry: NotificationCatalogEntry): String =
    if (id == entry.key) entry.displayTitle() else humanizeKey(id).ifEmpty { "a template" }

fun notifTemplateLines(entry: NotificationCatalogEntry): List<NotifTemplateLine> =
    NOTIF_CHANNEL_ORDER.filter { it in entry.allowedChannels }.map { channel ->
        val id = entry.templates[channel]
        NotifTemplateLine(
            channel = channel,
            name = if (id.isNullOrBlank()) "no template recorded" else notifTemplateName(id, entry),
            missing = id.isNullOrBlank(),
            retargetedFrom = if (channel == "email") {
                entry.emailTemplateRetargetedFrom?.let { notifTemplateName(it, entry) }
            } else {
                null
            },
        )
    }

/**
 * Everything the body can carry, deduped and sorted.
 *
 * Two lists become one on purpose. `mergeFields` is what the server hydrates
 * and a template author can already see; the emitters' `dataKeys` are the half
 * that lived only in source, and they are the half that matters for "are we
 * leaking info to the wrong ppl" — a template that prints one of these prints
 * it to whoever the recipient rule resolved.
 */
fun notifMergeFieldNames(entry: NotificationCatalogEntry): List<String> =
    (entry.mergeFields + entry.emitters.flatMap { it.dataKeys })
        .distinct()
        // #1592: in words, not keys: the server's words, else the key split.
        .map { key -> entry.mergeFieldLabels[key] ?: notifFieldWords(key) }
        .distinct()
        .sorted()
/**
 * A merge field key as words, for a key the server sent no label for (#1592):
 * `startTimeMs` reads "Start time", `nextVisit.date` "Next visit date",
 * `kinfolkId` "Kinfolk reference". Same rule as web's `fieldWords`.
 */
fun notifFieldWords(key: String): String {
    val words = key.trim()
        .replace(Regex("([a-z0-9])([A-Z])"), "$1 $2")
        .split(Regex("[._\\-\\s]+"))
        .map { it.lowercase() }
        .filter { it.isNotEmpty() && it != "ms" && it != "iso" && it != "list" }
        .map {
            when (it) {
                "id", "uid" -> "reference"
                "url" -> "link"
                else -> it
            }
        }
    val joined = words.joinToString(" ")
    return if (joined.isEmpty()) key else joined.replaceFirstChar { it.uppercase() }
}
/**
 * The channel senders' skip codes in words (#1592: the log printed
 * `recipient_no_phone`). Same table as web's `skipReasonWords`; a code this
 * does not know is split into words rather than printed as a key.
 */
private val SKIP_REASON_WORDS = mapOf(
    "recipient_no_email" to "the recipient has no email address on file",
    "recipient_no_phone" to "the recipient has no phone number on file",
    "recipient_hard_bounced" to "an earlier email to this address bounced, so it is not mailed again",
    "template_missing" to "there is no text message template for it",
    "template_text_empty" to "its text message template is empty",
    "unknown" to "the sender gave no reason",
)
fun notifSkipReasonWords(code: String): String =
    SKIP_REASON_WORDS[code] ?: notifFieldWords(code).lowercase()
/**
 * Who a delivery went to (#1592: the log printed the uid). The server's name,
 * else the uid as it is: a recipient nobody answers to is what the operator
 * needs to see, and is never shown blank.
 */
fun notifDeliveryRecipient(row: NotificationDeliveryRow): String =
    row.recipientName ?: row.recipientUid.ifBlank { "an unknown recipient" }

/** How a delivery attempt should read to a human. */
enum class NotifDeliveryTone { Good, Warn, Bad, Neutral }

data class NotifDeliveryPhrase(
    val label: String,
    val detail: String,
    val tone: NotifDeliveryTone,
)

/**
 * The honest phrasing for one channel attempt.
 *
 * "Sent" is the strongest thing this data supports and it is deliberately not
 * called "Delivered". `notificationDispatch/{id}/channels/{channel}.status`
 * turns 'sent' the moment a provider ACCEPTS the message — smtp2go queues the
 * email, Twilio queues the SMS, FCM enqueues the push. The engagement webhooks
 * carrying real delivered/bounced events match `external_messages` only and
 * never touch these subdocs, so a receipt for a catalog notification does not
 * exist anywhere in this system. A green "Delivered" here would be a guess
 * printed as a fact.
 */
fun notifDeliveryPhrase(
    status: String,
    skipReason: String?,
    errorMessage: String?,
): NotifDeliveryPhrase = when (status) {
    "sent" -> NotifDeliveryPhrase(
        label = "Handed to the provider",
        detail = "The provider accepted it. No delivery receipt is recorded, so this is not " +
            "proof it arrived.",
        tone = NotifDeliveryTone.Good,
    )
    "skipped" -> NotifDeliveryPhrase(
        label = "Skipped",
        detail = when {
            skipReason.isNullOrBlank() -> "Not sendable on this channel; no reason was recorded."
            skipReason == BUSINESS_EMAIL_UNSET ->
                "The business email in Settings > Business was blank, so this email had nowhere to go."
            else -> "Not sent on this channel: ${notifSkipReasonWords(skipReason)}."
        },
        tone = NotifDeliveryTone.Warn,
    )
    "failed" -> NotifDeliveryPhrase(
        label = "Failed",
        detail = if (errorMessage.isNullOrBlank()) {
            "The send failed, with no message recorded."
        } else {
            "The send failed: $errorMessage"
        },
        tone = NotifDeliveryTone.Bad,
    )
    "pending" -> NotifDeliveryPhrase(
        label = "Waiting",
        detail = "Queued for the channel sender, which has not run yet.",
        tone = NotifDeliveryTone.Neutral,
    )
    else -> NotifDeliveryPhrase(
        label = "Unknown",
        detail = "This channel record carries no status at all, which means its sender never ran.",
        tone = NotifDeliveryTone.Warn,
    )
}
