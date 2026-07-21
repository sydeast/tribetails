package com.tribetails.auntieos.web.data

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

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
    ) {
        val entry = ActivityLogEntry(
            actionType       = actionType,
            description      = description,
            status           = status,
            actorId          = actorId,
            targetId         = targetId,
            targetCollection = targetCollection,
        )
        scope.launch { client.logActivity(entry) }
    }
}
