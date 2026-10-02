package com.tribetails.auntieos.data.repository

import com.google.firebase.functions.FirebaseFunctions
import com.tribetails.auntieos.util.AuntieLog
import com.tribetails.auntieos.util.runCatchingCancellable

/**
 * #1083: the do-not-send list (`message_suppressions`) through its two
 * owner-only callables (`mytribe/functions/src/admin/messageSuppressions.ts`).
 * The collection is denied to every client in the rules, so there is no direct
 * Firestore path. The web twin is `auntieos-admin/src/api/messageSuppressions.ts`.
 *
 * `recipient` is the FULL address. Clear needs it and the server refuses the
 * masked form, so a row carries both: show `recipient`, send `recipient` back.
 *
 * Clear removes a hard BOUNCE and never an opt-out: the opt-out is the
 * household's own consent choice. A row that is both keeps its opt-out, and a
 * row that is only an opt-out has nothing to clear.
 */
class MessageSuppressionRepository(
    private val functions: FirebaseFunctions = FirebaseFunctions.getInstance("us-central1"),
) {

    data class Suppression(
        val recipient: String,
        val recipientRedacted: String,
        /** "email" or "sms". */
        val channel: String,
        /** "hard_bounce" or "opt_out". */
        val reason: String,
        /** "smtp2go" or "admin". */
        val source: String,
        val suppressedAtMs: Long,
        /** The household opted out, whether or not the address also bounced. */
        val optedOut: Boolean,
        /** The smtp2go webhook event id of the bounce, or null. */
        val eventId: String?,
    ) {
        /** Only a bounce can be cleared. */
        val clearable: Boolean get() = reason == "hard_bounce"
    }

    data class Page(val items: List<Suppression>, val nextCursor: String?)

    data class ClearResult(
        val channel: String,
        val recipientRedacted: String,
        /** True when the address also had an opt-out, which Clear leaves in place. */
        val optOutKept: Boolean,
    )

    /** [reason] is "all", "hard_bounce" or "opt_out". */
    suspend fun list(reason: String, cursor: String? = null): Result<Page> = runCatchingCancellable {
        val payload = buildMap<String, Any?> {
            put("reason", reason)
            if (cursor != null) put("cursor", cursor)
        }
        decodePage(invoke("listMessageSuppressions", payload))
    }.onFailure { log("listMessageSuppressions", it) }

    /** Clears a hard bounce. The server audits who did it. */
    suspend fun clear(recipient: String): Result<ClearResult> = runCatchingCancellable {
        val raw = invoke("clearMessageSuppression", mapOf("recipient" to recipient.trim()))
        ClearResult(
            channel = if (raw?.get("channel") == "sms") "sms" else "email",
            recipientRedacted = (raw?.get("recipientRedacted") as? String).orEmpty(),
            optOutKept = raw?.get("optOutKept") == true,
        )
    }.onFailure { log("clearMessageSuppression", it) }

    private suspend fun invoke(name: String, payload: Map<String, Any?>): Map<String, Any?>? {
        @Suppress("UNCHECKED_CAST")
        return functions.getHttpsCallable(name).call(payload).awaitCallable().data as? Map<String, Any?>
    }

    private fun log(name: String, t: Throwable) {
        if (t is kotlinx.coroutines.CancellationException) throw t
        AuntieLog.e("MessageSuppressionRepository.$name failed", t)
    }

    companion object {
        /** Pure. A row with no address is dropped; every other field has a safe default. */
        internal fun decodePage(raw: Map<String, Any?>?): Page {
            val items = (raw?.get("items") as? List<*>).orEmpty().mapNotNull { row ->
                val m = row as? Map<*, *> ?: return@mapNotNull null
                val recipient = (m["recipient"] as? String)?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
                val reason = if (m["reason"] == "hard_bounce") "hard_bounce" else "opt_out"
                Suppression(
                    recipient = recipient,
                    recipientRedacted = (m["recipientRedacted"] as? String).orEmpty(),
                    channel = if (m["channel"] == "sms") "sms" else "email",
                    reason = reason,
                    source = if (m["source"] == "smtp2go") "smtp2go" else "admin",
                    suppressedAtMs = (m["suppressedAtMs"] as? Number)?.toLong() ?: 0L,
                    // An opt-out only row is an opt-out by definition, whatever an older deploy sent.
                    optedOut = m["optedOut"] == true || reason == "opt_out",
                    eventId = (m["eventId"] as? String)?.takeIf { it.isNotEmpty() },
                )
            }
            val next = (raw?.get("nextCursor") as? String)?.takeIf { it.isNotEmpty() }
            return Page(items, next)
        }
    }
}
