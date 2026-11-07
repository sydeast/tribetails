package com.tribetails.auntieos.ui.admin.scheduling

/**
 * #1607: the bulk transitions worth offering for a selection, in the bar's
 * order. A picked request (DRAFT) can be approved or rejected; a picked visit on
 * the books (ACCEPTED) can be cancelled or rescheduled. The bar offered all
 * three transitions whatever was picked, so a selection of scheduled visits got
 * Approve and Reject buttons that could only skip. Same rule as the web's
 * `bulkActionsFor` and the desktop console's `bulkActionsForStatuses`.
 */
internal fun bulkActionsForSelection(
    selected: Set<String>,
    requestIds: Set<String>,
    scheduledIds: Set<String>,
): List<String> {
    val anyRequest = selected.any { it in requestIds }
    val anyScheduled = selected.any { it in scheduledIds }
    return buildList {
        if (anyRequest) { add("APPROVE"); add("REJECT") }
        if (anyScheduled) { add("CANCEL"); add("RESCHEDULE") }
    }
}
