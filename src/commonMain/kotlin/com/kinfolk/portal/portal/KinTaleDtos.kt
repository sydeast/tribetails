package com.kinfolk.portal.portal

import com.kinfolk.portal.components.RoutePoint

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
