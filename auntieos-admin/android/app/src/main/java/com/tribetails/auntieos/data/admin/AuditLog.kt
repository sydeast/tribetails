package com.tribetails.auntieos.data.admin

import com.tribetails.auntieos.data.repository.AuntieRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * Fire-and-forget audit logger. Writes a row to the `activity_log` Firestore
 * collection via AuntieRepository.logActivity. Mirrors web AuditLog.fire shape
 * so docs render identically on both platforms.
 *
 * Failures are swallowed at the call site - callers must not block their UI on
 * the audit write - but the underlying repo method still logs the platform
 * error via AuntieLog so audits won't fail silently in dev logs.
 */
object AuditLog {
    fun fire(
        scope: CoroutineScope,
        repository: AuntieRepository,
        actionType: String,
        description: String,
        targetId: String = "",
        targetCollection: String = "",
        status: String = "SUCCESS",
        actorIdOverride: String = "",
    ) {
        val entry = buildEntry(
            actionType, description, status, targetId, targetCollection, actorIdOverride,
        )
        scope.launch {
            runCatching { repository.logActivity(entry) }
        }
    }

    /**
     * Awaited variant - suspends until the activity_log write completes (or
     * fails). Use this when the caller is itself a suspending repo method and
     * the audit MUST land before the function returns (e.g. saveFormSchema,
     * deleteFormSchema). Fire-and-forget [fire] is fine for UI-layer callers
     * where dropping a trailing audit entry on process death is acceptable.
     *
     * Per [[fail-loud-policy]]: the underlying repository.logActivity already
     * routes any error through AuntieLog.e, so a failed audit will not
     * silently disappear in dev logs.
     */
    suspend fun fireSync(
        repository: AuntieRepository,
        actionType: String,
        description: String,
        targetId: String = "",
        targetCollection: String = "",
        status: String = "SUCCESS",
        actorIdOverride: String = "",
    ) {
        val entry = buildEntry(
            actionType, description, status, targetId, targetCollection, actorIdOverride,
        )
        repository.logActivity(entry)
    }

    private fun buildEntry(
        actionType: String,
        description: String,
        status: String,
        targetId: String,
        targetCollection: String,
        actorIdOverride: String,
    ): ActivityLogEntry = ActivityLogEntry(
        actionType       = actionType,
        description      = description,
        status           = status,
        targetId         = targetId,
        targetCollection = targetCollection,
        actorId          = actorIdOverride,
    )
}
