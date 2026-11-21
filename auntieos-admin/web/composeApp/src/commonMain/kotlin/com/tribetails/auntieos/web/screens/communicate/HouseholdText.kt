package com.tribetails.auntieos.web.screens.communicate

import com.tribetails.auntieos.web.screens.cutWhole

/**
 * #2408, operator ruling 2026-11-14: a household's text message stays short and
 * links to the full message in MyTribe. An approved Text draft is texted as a
 * short line followed by "More in MyTribe:" and a link to the message's own
 * entry on the household's notifications list, where it reads whole.
 *
 * This is what the composer shows for a Text, so the operator approves the text
 * the household will get and not the draft it was cut from. The same rule as
 * the server's `householdSms` (`notifications/templateParsers.ts`), which is
 * the one that decides what is sent, and as the web admin's
 * `lib/householdText.ts`.
 *
 * #2316: that is for a household with a MyTribe account. One with none is
 * texted the whole message (`householdWholeTextParts`, below).
 */
/** Where MyTribe lives. The server's `PORTAL_URL`. */
internal const val MYTRIBE_URL = "https://kinfolk.tribetails.com"
/** The longest message a household text carries before it is cut. */
internal const val HOUSEHOLD_TEXT_LINE_MAX = 200
/** What comes before the link. */
internal const val HOUSEHOLD_TEXT_LINK_LABEL = "More in MyTribe:"
/** The longest unfinished word the cut steps back over. */
private const val WORD_BACKOFF = 30
/** Every run of spaces and line breaks the server folds to one space. */
private val SPACES = Regex("[\\s\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]+")
private val ADDRESS = Regex("://|^www\\.", RegexOption.IGNORE_CASE)
internal data class HouseholdTextPreview(
    /** The message as texted, before the link. */
    val line: String,
    /** The message was longer than the short line, so the rest is only in MyTribe. */
    val cut: Boolean,
    /** "More in MyTribe:" and a link follow the line. False when the message carries its own MyTribe link and fits. */
    val linkAdded: Boolean,
)
/** [text] cut to at most [max] at the end of a word. A web address the cut landed inside is dropped whole. */
private fun cutAtWord(text: String, max: Int): String {
    val head = cutWhole(text, max)
    if (head.length == text.length || text[head.length] == ' ') return head.trimEnd()
    val lastSpace = head.lastIndexOf(' ')
    if (lastSpace <= 0) return head
    val unfinished = head.substring(lastSpace + 1)
    val isAddress = ADDRESS.containsMatchIn(unfinished)
    return if (isAddress || unfinished.length <= WORD_BACKOFF) head.substring(0, lastSpace).trimEnd() else head
}
/** The text a household is sent for these words. Pure. */
internal fun householdTextPreview(body: String): HouseholdTextPreview {
    val flat = body.replace(SPACES, " ").trim()
    if (flat.isEmpty()) return HouseholdTextPreview(line = "", cut = false, linkAdded = false)
    val longest = HOUSEHOLD_TEXT_LINE_MAX + 1 + "$HOUSEHOLD_TEXT_LINK_LABEL $MYTRIBE_URL/notifications".length
    if (flat.contains(MYTRIBE_URL) && flat.length <= longest) {
        return HouseholdTextPreview(line = flat, cut = false, linkAdded = false)
    }
    val words = flat.split(' ').filter { !it.contains(MYTRIBE_URL) }.joinToString(" ")
    val cut = words.length > HOUSEHOLD_TEXT_LINE_MAX
    return HouseholdTextPreview(
        line = if (cut) cutAtWord(words, HOUSEHOLD_TEXT_LINE_MAX - 3) + "..." else words,
        cut = cut,
        linkAdded = true,
    )
}
/** The preview as one line: the text, then where its link goes. Pure. */
internal fun householdTextPreviewLine(body: String): String {
    val p = householdTextPreview(body)
    return if (p.linkAdded) "${p.line} $HOUSEHOLD_TEXT_LINK_LABEL (link)" else p.line
}
/**
 * #2316, operator ruling 2026-11-20: a household with no MyTribe account has
 * no notifications list for a link to open, so it is texted the WHOLE message
 * instead, as several texts when one cannot carry it. The server decides who
 * that is with `resolveKinfolkUid` (`sendGeneratedDraft`), which also reads the
 * household's member records and can say "nobody" for a household whose
 * `kinfolk.uid` is filled in. The roster cannot see that, so the confirm asks
 * the server the same question (`previewVisitNotification` without a key,
 * whose `household_has_no_portal_account` is exactly a null
 * `resolveKinfolkUid`, checked before anything else). The same rule as the web
 * admin's `lib/householdText.ts`.
 */
enum class HouseholdTextAccount { Checking, Account, NoAccount, Unknown }
/** The longest body one text carries. The server's `SMS_BODY_MAX` (Twilio refuses more). */
internal const val SMS_BODY_MAX = 1600
/** A `previewVisitNotification` answer's reason as an account state. Pure. */
fun householdTextAccountOfReason(reason: String?): HouseholdTextAccount =
    if (reason == "household_has_no_portal_account") HouseholdTextAccount.NoAccount else HouseholdTextAccount.Account
/** What JavaScript's `trim` takes off, so the split matches the server's to the character. */
private const val JS_SPACE = "[\\s\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]"
private val JS_LEADING = Regex("^$JS_SPACE+")
private val JS_TRAILING = Regex("$JS_SPACE+$")
/**
 * The whole message as the texts it goes as, for a household with no MyTribe
 * account. Pure. The same split as the server's `householdWholeSmsParts`:
 * trimmed, line breaks kept, no link, and a message over [max] split at the
 * last space or line break when one is in the last fifth, else where it fits.
 */
internal fun householdWholeTextParts(body: String, max: Int = SMS_BODY_MAX): List<String> {
    val parts = mutableListOf<String>()
    var rest = body.replace(JS_LEADING, "").replace(JS_TRAILING, "")
    while (rest.length > max) {
        val head = cutWhole(rest, max)
        val breakAt = maxOf(head.lastIndexOf(' '), head.lastIndexOf('\n'))
        val part = if (breakAt > max * 0.8) head.substring(0, breakAt) else head
        parts += part.replace(JS_TRAILING, "")
        rest = rest.substring(part.length).replace(JS_LEADING, "")
    }
    if (rest.isNotEmpty()) parts += rest
    return parts
}
/** What one household is texted, once its account is known. */
internal sealed interface HouseholdTextAsSent {
    data object Checking : HouseholdTextAsSent
    data object Unknown : HouseholdTextAsSent
    /** The short line and "More in MyTribe: (link)". */
    data class Short(val line: String) : HouseholdTextAsSent
    /** The whole message, one entry per text. */
    data class Whole(val parts: List<String>) : HouseholdTextAsSent
}
/** What this household is texted for these words. Pure. */
internal fun householdTextAsSent(body: String, account: HouseholdTextAccount): HouseholdTextAsSent = when (account) {
    HouseholdTextAccount.Checking -> HouseholdTextAsSent.Checking
    HouseholdTextAccount.Unknown -> HouseholdTextAsSent.Unknown
    HouseholdTextAccount.NoAccount -> HouseholdTextAsSent.Whole(householdWholeTextParts(body))
    HouseholdTextAccount.Account -> HouseholdTextAsSent.Short(householdTextPreviewLine(body))
}
/** The confirm's Channel line for a Text. Says short or whole only once the server has answered. Pure. */
internal fun householdTextChannelLine(account: HouseholdTextAccount): String = when (account) {
    HouseholdTextAccount.Account -> "Text, kept short, with a link to MyTribe"
    HouseholdTextAccount.NoAccount -> "Text, the whole message, because they have no MyTribe account"
    else -> "Text"
}
/**
 * The Text as lines to draw, for a confirm or a preview: one line for one text,
 * a heading and one line per text for several, or what is not yet known. Pure.
 */
internal fun householdTextAsSentLines(body: String, account: HouseholdTextAccount): List<String> =
    when (val sent = householdTextAsSent(body, account)) {
        HouseholdTextAsSent.Checking -> listOf("Text: Checking whether they have a MyTribe account…")
        HouseholdTextAsSent.Unknown -> listOf(
            "Text: Their MyTribe account could not be checked. With an account they get a short line and a link; " +
                "without one they get the whole message.",
            "Message: $body",
        )
        is HouseholdTextAsSent.Short -> listOf("Text: ${sent.line}")
        is HouseholdTextAsSent.Whole ->
            if (sent.parts.size <= 1) listOf("Text: ${sent.parts.firstOrNull().orEmpty()}")
            else listOf("Text, sent as ${sent.parts.size} texts:") +
                sent.parts.mapIndexed { i, p -> "${i + 1} of ${sent.parts.size}: $p" }
    }
