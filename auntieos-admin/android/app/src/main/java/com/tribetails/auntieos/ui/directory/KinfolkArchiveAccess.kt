package com.tribetails.auntieos.ui.directory

import com.google.firebase.functions.FirebaseFunctionsException
import com.tribetails.auntieos.domain.isOwnerClaims

/**
 * #2161, operator ruling 2026-11-13: only the owner archives or restores a
 * Kinfolk household. The server enforces it (the owner-only
 * `setKinfolkArchived` callable, and rules that refuse a direct change to the
 * archive fields); this file is the client half on Android, matching web
 * `KinfolkEdit.tsx` and `api/kinfolkProfileWrite.ts`.
 */

/** What a refused archive or restore says. Web shows the same sentence. */
internal const val KINFOLK_ARCHIVE_OWNER_ONLY = "Only the owner can archive or restore a Kinfolk household."

/** The status chips the editor offers. `archived` is not one: Archive / Restore are their own controls. */
internal val KINFOLK_PICKABLE_STATUSES = listOf("active", "prospect", "inactive")

/**
 * The owner: the `admin` claim and NOT the Auntie role. An account carrying
 * both degrades to the Auntie, as `isOwner()` in the rules and the server gate
 * do, so it is not offered owner-only controls.
 */
internal fun isOwnerFromClaims(claims: Map<String, Any?>): Boolean = isOwnerClaims(claims)

/** Which archive control the household editor shows. */
internal enum class KinfolkArchiveControl { NONE, ARCHIVE, RESTORE }

/**
 * The owner sees Archive on a household that is not archived and Restore on one
 * that is. Anyone else, and anyone while the check is still running
 * ([isOwner] null), sees neither.
 */
internal fun kinfolkArchiveControlFor(isOwner: Boolean?, status: String): KinfolkArchiveControl = when {
    isOwner != true -> KinfolkArchiveControl.NONE
    status.equals("archived", ignoreCase = true) -> KinfolkArchiveControl.RESTORE
    else -> KinfolkArchiveControl.ARCHIVE
}

/** The line the editor shows when an archive or restore fails. */
internal fun kinfolkArchiveErrorText(err: Throwable, fallback: String): String =
    if ((err as? FirebaseFunctionsException)?.code == FirebaseFunctionsException.Code.PERMISSION_DENIED) {
        KINFOLK_ARCHIVE_OWNER_ONLY
    } else {
        err.message?.takeIf { it.isNotBlank() } ?: fallback
    }
