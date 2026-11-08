package com.tribetails.auntieos.ui.admin

/**
 * What an Activity Log entry's description says, in the operator's words
 * (#1747). Port of the web `lib/activityWords.ts`; the two must agree.
 *
 * Four writers used to put a Firestore path in the description ("Approved
 * generated_drafts/<id> (<kinfolkId>)" here and on the web and desktop, and
 * the server's "Sent draft generated_drafts/<id> as KinTale <reportId> (...)",
 * "Deleted draft generated_drafts/<id> (...)" and "Deleted unsent KinTale draft
 * kin_care_reports/<id> (...)"). The Activity Log shows a
 * description as written, so the operator read a collection path and two ids.
 *
 * The writers now write these words. The entries already stored are evidence
 * rows and are never rewritten; [activityDescriptionWords] reads them as the
 * same words at display time. The ids stay on the entry as its target, its
 * household and its payload.
 */
object ActivityWords {
    const val DRAFT_APPROVED = "Approved an Auntie AI draft"
    const val KINTALE_DRAFT_SENT = "Sent a KinTale draft"
    const val KINTALE_DRAFT_DELETED = "Deleted a KinTale draft"
}

/** The stored shapes, in full: the path, any ids after it, the household in brackets. */
private val STORED_SHAPES: List<Pair<Regex, String>> = listOf(
    Regex("""^Approved generated_drafts/\S+(?: \([^)]*\))?$""") to ActivityWords.DRAFT_APPROVED,
    Regex("""^Sent draft generated_drafts/\S+ as KinTale \S+(?: \([^)]*\))?$""") to ActivityWords.KINTALE_DRAFT_SENT,
    Regex("""^Deleted draft generated_drafts/\S+(?: \([^)]*\))?$""") to ActivityWords.KINTALE_DRAFT_DELETED,
    Regex("""^Deleted unsent KinTale draft kin_care_reports/\S+(?: \([^)]*\))?$""") to ActivityWords.KINTALE_DRAFT_DELETED,
)

/** Any other mention of a draft's path, for a writer this file does not know. */
private val DRAFT_PATH = Regex("""(?:generated_drafts|kin_care_reports)/[\w-]+""")

/** A stored description as the operator reads it. Text with no path passes through. */
fun activityDescriptionWords(description: String): String {
    val text = description.trim()
    STORED_SHAPES.firstOrNull { (shape, _) -> shape.matches(text) }?.let { return it.second }
    return DRAFT_PATH.replace(text, "a draft")
}
