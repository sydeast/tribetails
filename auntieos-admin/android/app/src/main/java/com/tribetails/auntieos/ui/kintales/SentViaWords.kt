package com.tribetails.auntieos.ui.kintales

/**
 * The send-channel label on a KinTale, in words, or null when the stored value
 * is not something the operator should read.
 *
 * - The backfill provenance markers ("legacy_visit_logs", "legacy_orphan") and
 *   a blank value are migration bookkeeping: "imported".
 * - #1817: "pending" and "catalog" are the send path's own markers for who
 *   tells the household (mytribe/functions/src/admin/kinTaleDrafts.ts), not
 *   channels. Either way the tale went to the household's MyTribe, so both read
 *   "MyTribe". Neither says whether a notice reached them.
 * - A real channel reads as a word ("email", "text", "push").
 * - Anything else is a stored value this screen does not know: null, so no raw
 *   key lands on screen.
 *
 * Same words as admin web (lib/kinTaleFormat.ts#sentViaLabel) and the desktop
 * console (screens/kintales/SentViaWords.kt).
 */
internal fun sentViaWords(sentVia: String): String? {
    val key = sentVia.trim().lowercase()
    if (key.isEmpty() || key.startsWith("legacy_")) return "imported"
    return SENT_VIA_WORDS[key]
}

private val SENT_VIA_WORDS = mapOf(
    "pending" to "MyTribe",
    "catalog" to "MyTribe",
    "email" to "email",
    "sms" to "text",
    "push" to "push",
)
