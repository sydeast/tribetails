package com.tribetails.auntieos.ui.admin

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * #1752: the other writers that put an id or a catalog key in the sentence.
 * Each stored shape and the words it reads as. Same pairs as the web
 * `activityWords.test.ts`; the right-hand side is what the server writes now,
 * except that an old notification row names its key in words.
 */
class ActivityIdWordsTest {
    private val storedIdShapes = listOf(
        "Notification kincare.booking.confirm delivered via email" to "Delivered \"Kincare booking confirm\" by email",
        "Notification invoice.new dispatched to email, push" to "Sent \"Invoice new\" by email and push notification",
        "Notification (unknown key) dispatched to sms" to "Sent a notification by text message",
        "Notification kincare.changed archived" to "Archived \"Kincare changed\"",
        "Notification n8Xq2LmP0aZ restored to the active inbox" to "Restored a notification to the notifications list",
        "Notification kincare.changed viewed" to "Viewed \"Kincare changed\"",
        "Notification kincare.changed marked unread" to "Marked \"Kincare changed\" unread",
        "COMPLETE on session s_9fK2: SCHEDULED -> COMPLETED" to "Completed the visit: scheduled to completed",
        "APPROVE on session s_9fK2: PENDING -> SCHEDULED" to "Approved the visit: requested to scheduled",
        "ARRIVED on session s_9fK2: ON_MY_WAY -> ARRIVED" to "Marked the arrival: on the way to arrived",
        "COMPLETE on session s_9fK2: already COMPLETED, no write" to "Did not complete the visit: the visit was already completed",
        "COMPLETE refused: session 's_9fK2' not found" to "Could not complete the visit: the visit was not found",
        "DEPARTED refused: unreadable status on session 's_9fK2'" to "Could not mark the departure: the visit's status could not be read",
        "APPROVE refused: illegal from CANCELLED" to "Could not approve the visit: the visit is cancelled",
        "COMPLETE refused: session 's_9fK2' has no arrival or departure recorded" to "Could not complete the visit: no arrival or departure recorded",
        "COMPLETE refused: session 's_9fK2' arrival was recorded 2400m from the household (radius 200m)" to "Could not complete the visit: arrival was recorded 2400m from the household (radius 200m)",
        "APPROVE refused: That time overlaps another visit." to "Could not approve the visit: That time overlaps another visit.",
        "Arrival location check on session s_9fK2: outside" to "Arrival location check: outside the household radius",
        "Account credit of 2500 cents given to household kf_rivera" to "Gave \$25.00 account credit",
        "Admin created 4 visit(s) (weekly) for kf_rivera" to "Created 4 visits (weekly)",
        "Assigned orphan KinTale r_77 to kinfolk The Rivera Home (kf_rivera)" to "Assigned a KinTale from Needs triage to The Rivera Home",
        "Marked orphan KinTale r_77 as duplicate of r_12" to "Marked a KinTale in Needs triage as a duplicate",
        "Archived orphan KinTale r_77 as bad data: test row" to "Archived a KinTale from Needs triage as bad data: test row",
        "Invoice PDF generated for inv_3Qp" to "Made the PDF for an invoice",
        "Kinfolk downloaded invoice PDF for inv_3Qp" to "Household downloaded the PDF for an invoice",
        "Vet clinic archive refused: 'vc_12' not found" to "Vet clinic archive refused: the clinic was not found",
        "Edited session s_9fK2: serviceType, kinIds, kinNames" to "Edited a visit: service, kin",
        "Synced visit s_9fK2 to Google Calendar (updated)" to "Synced a visit to Google Calendar (updated)",
        "AI tale titles applied from batch b_1 (3 applied, 1 skipped, 0 errored)" to "Applied AI KinTale titles (3 applied, 1 skipped, 0 errored)",
        "Invite inv_k2 was sent, but the Auntie notice was not: ADMIN_ORIGIN is not configured." to "An invite was sent, but the Auntie notice was not: ADMIN_ORIGIN is not configured.",
        "Payment notification for invoice inv_3Qp was not delivered after 5 retries" to "A payment notification was not delivered after 5 retries",
    )

    @Test
    fun storedIdsReadAsWords() {
        for ((stored, words) in storedIdShapes) {
            assertEquals(stored, words, activityDescriptionWords(stored))
        }
    }

    @Test
    fun theWordsTheWritersNowStoreReadAsThemselves() {
        for ((_, words) in storedIdShapes) {
            assertEquals(words, words, activityDescriptionWords(words))
        }
    }
}
