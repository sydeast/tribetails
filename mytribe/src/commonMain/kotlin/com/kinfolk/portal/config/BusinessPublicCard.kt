package com.kinfolk.portal.config

import com.kinfolk.portal.firebase.FirestoreClient
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * #1321: the public business card, read straight from `business_public/card`
 * BEFORE sign-in. The sign-in and email-action screens put "by <business>"
 * under the MyTribe wordmark so a household knows it has the right app, and
 * the About screen (#1411) reuses the same read.
 *
 * The screens that need it have no user yet, so no callable can answer, and a
 * callable's cold start would delay the one line on the page with nothing to
 * wait for. `mytribe/firestore.rules` opens `business_public/{docId}` to every
 * reader and no client writer; the `onBusinessSettingsWrite` trigger keeps the
 * document equal to the four public fields of the staff-only settings
 * document, and `functions/src/lib/businessPublicCard.ts` is the closed list.
 * The mapping here is a field-for-field copy of it and of the web portal's
 * `lib/businessPublicCard.ts`.
 *
 * NO NAME IS EVER INVENTED. A missing card, a blank name, a failed read and a
 * cold cache all read as `name == ""`, and the screens leave the line out.
 */
@Serializable
data class BusinessPublicCard(
    val name: String = "",
    val phone: String = "",
    /** Every day of [PUBLIC_HOURS_DAYS] present; "HH:MM-HH:MM" when open, "" when closed. */
    val hours: Map<String, String> = PUBLIC_HOURS_DAYS.associateWith { "" },
    /** "" until #1410 lands and the operator sets one; always https when set. */
    val privacyPolicyUrl: String = "",
) {
    companion object {
        const val COLLECTION = "business_public"
        const val DOCUMENT = "card"
    }
}

/** Monday-first, the order the settings editor writes and the card carries. */
val PUBLIC_HOURS_DAYS = listOf("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")

private fun str(v: Any?): String = (v as? String)?.trim().orEmpty()

/** The stored document as the card. Unknown keys are dropped; a bad value reads as unset. */
fun businessPublicCardFromDocument(fields: Map<String, Any?>?): BusinessPublicCard {
    if (fields == null) return BusinessPublicCard()
    val rawHours = fields["hours"] as? Map<*, *>
    val url = str(fields["privacyPolicyUrl"])
    return BusinessPublicCard(
        name = str(fields["name"]),
        phone = str(fields["phone"]),
        hours = PUBLIC_HOURS_DAYS.associateWith { day -> str(rawHours?.get(day)) },
        privacyPolicyUrl = if (url.startsWith("https://")) url else "",
    )
}

/** Reads the card. Throws whatever the client throws; the caller decides the fallback. */
suspend fun readBusinessPublicCard(firestore: FirestoreClient): BusinessPublicCard =
    businessPublicCardFromDocument(firestore.getDocument(BusinessPublicCard.COLLECTION, BusinessPublicCard.DOCUMENT))

/**
 * The last card this device saw, so a cold open shows the business name with
 * the headline instead of a beat later. [load] and [save] default to the
 * platform store ([BusinessPublicCardStore]); a test hands in lambdas.
 *
 * A corrupt or missing entry reads as null, never as an error: the cache
 * exists to save a beat, and a sign-in form must not fail over it.
 */
class BusinessPublicCardCache(
    private val load: () -> String? = { BusinessPublicCardStore.load() },
    private val save: (String) -> Unit = { BusinessPublicCardStore.save(it) },
) {
    private val json = Json { ignoreUnknownKeys = true }

    fun read(): BusinessPublicCard? {
        val raw = runCatching { load() }.getOrNull() ?: return null
        return runCatching { json.decodeFromString(BusinessPublicCard.serializer(), raw) }.getOrNull()
    }

    fun write(card: BusinessPublicCard) {
        runCatching { save(json.encodeToString(BusinessPublicCard.serializer(), card)) }
    }
}

/**
 * Per-device persistence for the last public card. Android keeps it in
 * SharedPreferences, web in localStorage and the desktop in the JVM user
 * preferences, so each one survives a restart: a cold open is the whole point.
 */
expect object BusinessPublicCardStore {
    fun load(): String?
    fun save(json: String)
}
