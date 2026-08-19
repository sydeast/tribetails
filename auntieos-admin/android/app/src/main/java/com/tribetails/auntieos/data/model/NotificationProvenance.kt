package com.tribetails.auntieos.data.model

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
                label = "Sent by another system",
                detail = "An outside system delivers this one. The dispatcher skips it entirely, " +
                    "so these toggles control nothing.",
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
    rosterPath: String,
): List<String> = entry.whoReceives.map { sentence ->
    when {
        !sentence.contains("business admin") -> sentence
        businessAdminCount == null ->
            "$sentence The roster at $rosterPath could not be read just now, so the number is unknown."
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
    val name = member.displayName ?: member.uid
    val parts = buildList {
        add(member.email ?: "no email on file")
        if (!member.hasStaffRecord) add("no staff record for ${member.uid}")
        if (member.defaultAssignee) add("unassigned visits default to them")
    }
    "$name (${parts.joinToString("; ")})"
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
    return "Nobody is stored at ${roster.rosterPath}, so these are the operator allowlist accounts " +
        "the next business notification would fall back to. Call provisionBusinessAdmins to make " +
        "the roster explicit."
}
/** One "channel -> template document" line for a channel the row offers. */
data class NotifTemplateLine(
    val channel: String,
    val path: String,
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

fun notifTemplateLines(entry: NotificationCatalogEntry): List<NotifTemplateLine> =
    NOTIF_CHANNEL_ORDER.filter { it in entry.allowedChannels }.map { channel ->
        val id = entry.templates[channel]
        NotifTemplateLine(
            channel = channel,
            path = if (id.isNullOrBlank()) "no template recorded" else "${channel}Templates/$id",
            missing = id.isNullOrBlank(),
            retargetedFrom = if (channel == "email") entry.emailTemplateRetargetedFrom else null,
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
    (entry.mergeFields + entry.emitters.flatMap { it.dataKeys }).distinct().sorted()

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
        detail = if (skipReason.isNullOrBlank()) {
            "Not sendable on this channel; no reason was recorded."
        } else {
            "Not sendable on this channel: $skipReason."
        },
        tone = NotifDeliveryTone.Warn,
    )
    "failed" -> NotifDeliveryPhrase(
        label = "Failed",
        detail = if (errorMessage.isNullOrBlank()) {
            "The send threw, with no message recorded."
        } else {
            "The send threw: $errorMessage"
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
