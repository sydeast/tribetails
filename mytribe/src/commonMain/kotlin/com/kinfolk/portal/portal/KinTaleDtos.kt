package com.kinfolk.portal.portal

import com.kinfolk.portal.components.RoutePoint

/** Same shape KinTaleMedia already has (WriteDtos.kt), minus `expiresAtMs` — the list response is a preview, not the gallery's signed-URL contract. */
data class KinTaleThumb(
    val id: String,
    val url: String,
    val contentType: String?,
)

/** One care task the Auntie's checklist recorded as DONE for this visit (task-25, P4). */
data class KinTaleChecklistItem(
    val key: String,
    val text: String,
)

data class KinTale(
    val id: String,
    val body: String,
    val authorDisplayName: String?,
    val mediaIds: List<String>,
    val sentAtMs: Long?,
    val shared: Boolean,
    /** Optional GPS visit route forwarded by AuntieOS on DEPARTED. Empty list = no route. */
    val gpsRoute: List<RoutePoint> = emptyList(),
    /** Optional summary metrics. Null when AuntieOS did not include them. */
    val gpsDistanceMeters: Double? = null,
    val gpsDurationSeconds: Long? = null,
    /**
     * Preview media for the feed card's thumbnail strip (task-24, P3):
     * at most the first 8 of `mediaIds`, resolved server-side. Empty on an
     * older deployed function that doesn't send `thumbs` yet, same as a
     * tale with no media — the screen can't tell the two apart and doesn't
     * need to (no row is the correct render for both).
     */
    val thumbs: List<KinTaleThumb> = emptyList(),
    /**
     * When the Auntie arrived / departed, resolved server-side from the
     * visit's session (task-25, P4). Null means not recorded — never zero,
     * never "now". `departedAtIso` can be null while `arrivedAtIso` is set (a
     * departure that was never stamped).
     */
    val arrivedAtIso: String? = null,
    val departedAtIso: String? = null,
    /**
     * Care tasks checked done on this visit. CHECKED ITEMS ONLY — an item
     * that wasn't checked has no entry here and must never be shown as "not
     * done" (the source data can't tell "left undone" apart from "not
     * applicable to this visit"). Empty when nothing was recorded.
     */
    val checklist: List<KinTaleChecklistItem> = emptyList(),
)

data class KinTalesResult(
    val tales: List<KinTale>,
    val hasMore: Boolean,
)

data class ShareLinkCreated(
    val shareId: String,
    val shareUrl: String,
)

enum class CommentAuthorRole { Kinfolk, Admin, Guest }

data class KinTaleComment(
    val id: String,
    val authorRole: CommentAuthorRole,
    val authorDisplayName: String?,
    /** Set when authorRole=Guest (unauth shared-link viewer). */
    val guestName: String? = null,
    val body: String,
    val parentCommentId: String? = null,
    val createdAtMs: Long?,
)

/** A single love/heart toggle per kinfolk per tale — mirrors the mockup's
 *  "You and 2 others loved this" line (kinTaleEngagement.ts's
 *  toggleKinTaleLove/getKinTaleReaction). */
data class KinTaleReaction(
    val loved: Boolean,
    val loveCount: Int,
)
