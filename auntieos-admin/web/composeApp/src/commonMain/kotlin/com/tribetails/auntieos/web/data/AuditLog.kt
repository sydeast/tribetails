package com.tribetails.auntieos.web.data

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject

/**
 * Fire-and-forget audit logger. Writes a row to the `activity_log` Firestore
 * collection so the Activity Log screen surfaces real events (rather than the
 * mock data the Android side currently shows). Failures are intentionally
 * swallowed at the call site - callers must not block their UI on the audit
 * write - but the underlying [FirestoreClient.logActivity] still surfaces the
 * platform error inside the [WriteResult.Err] for explicit callers that care.
 */
object AuditLog {
    fun fire(
        scope: CoroutineScope,
        client: FirestoreClient,
        actorId: String,
        actionType: String,
        description: String,
        targetId: String = "",
        targetCollection: String = "",
        status: String = "SUCCESS",
        /** The household the entry is about, when there is one (#1747). */
        familyId: String = "",
        /**
         * #1820: the facts behind the sentence (visit id, from, to, a name, the
         * changed field names). Only the keys the server lists are accepted
         * (`mytribe/functions/src/lib/activityPayload.ts`); never a secret,
         * money, an address, a phone number, an email or the text of a note.
         * No role is passed: the server works out who the caller is.
         */
        payload: JsonObject? = null,
    ) {
        val entry = ActivityLogEntry(
            actionType       = actionType,
            description      = description,
            status           = status,
            actorId          = actorId,
            targetId         = targetId,
            targetCollection = targetCollection,
            familyId         = familyId,
            payload          = payload,
        )
        scope.launch { client.logActivity(entry) }
    }
}
