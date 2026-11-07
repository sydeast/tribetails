package com.tribetails.auntieos.domain

import com.tribetails.auntieos.data.contracts.PreviewInvoiceNoticeResult

/**
 * #1609: the confirm's sentence about WHO a send reaches and HOW, from the
 * `previewInvoiceNotice` callable (the same recipient, prefs, operator
 * override and household gate the real send uses).
 *
 * Same sentences as admin web's `lib/invoiceNoticePreview.ts` and the desktop
 * console's `data/InvoiceNoticePreview.kt`. Pure; tested.
 */
fun noticePreviewSentence(preview: PreviewInvoiceNoticeResult): String {
    if (!preview.hasRecipient) {
        return "No one in this household can receive billing notices, so nobody will be told."
    }
    val who = preview.recipientName.trim().ifEmpty { "the household" }
    if (!preview.householdGateLive) {
        return "Household notices are paused before launch, so $who will not hear about this yet."
    }
    when (preview.disabled) {
        "operator" -> return "This notice is turned off in Settings, so $who will not get it."
        "marketing" -> return "$who has not opted in to this notice, so they will not get it."
    }
    val ways = mutableListOf<String>()
    val missing = mutableListOf<String>()
    if (preview.email.on) {
        if (preview.email.address.isNotBlank()) ways += "email to ${preview.email.address}" else missing += "no email address"
    }
    if (preview.sms.on) {
        if (preview.sms.address.isNotBlank()) ways += "text to ${preview.sms.address}" else missing += "no phone number"
    }
    if (preview.push.on) ways += "a phone notification"
    val gaps = if (missing.isEmpty()) "" else " Their account has ${missing.joinToString(" and ")} on file."
    if (ways.isEmpty()) {
        return "$who has no way to be reached for this notice, so it will show only in their notifications list in the app.$gaps"
    }
    val joined = if (ways.size == 1) ways[0] else ways.dropLast(1).joinToString(", ") + " and " + ways.last()
    return "Goes to $who by $joined, and in their notifications list.$gaps"
}
