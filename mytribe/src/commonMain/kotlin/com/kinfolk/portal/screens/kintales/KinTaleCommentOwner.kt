package com.kinfolk.portal.screens.kintales

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.kinfolk.portal.nav.avatarInitial
import com.kinfolk.portal.portal.CommentAuthorRole
import com.kinfolk.portal.portal.KinTaleComment
import com.kinfolk.portal.theme.KinfolkBrand
import com.kinfolk.portal.theme.KinfolkGradients
import com.kinfolk.portal.theme.LocalKinfolkTypography

/**
 * Who is reading the KinTale thread (#2378): the signed-in uid, and the name
 * the header avatar is drawn from, so the composer and the reader's own
 * comments carry the header's letter. Null uid means nothing is marked as yours.
 */
data class KinTaleViewer(val uid: String?, val name: String) {
    companion object {
        val Unknown = KinTaleViewer(uid = null, name = "")
    }
}

/** True for the signed-in reader's own household comment. Same rule as `isOwnComment` in the web portal's kinTalesApi.ts. */
internal fun isOwnKinTaleComment(comment: KinTaleComment, viewerUid: String?): Boolean =
    !viewerUid.isNullOrBlank() &&
        comment.authorUid == viewerUid &&
        comment.authorRole == CommentAuthorRole.Kinfolk &&
        comment.guestName.isNullOrBlank()

/**
 * The author line on a comment row. The reader's own comment reads
 * "<name> (you)" when the server named the person, else "You", never the
 * household's name. Every other row reads [kinTaleCommentAuthorLabel].
 * Mirrors `commentAuthorLabel` in the web portal's kinTalesApi.ts.
 */
internal fun kinTaleCommentRowLabel(comment: KinTaleComment, viewerUid: String?): String {
    if (!isOwnKinTaleComment(comment, viewerUid)) return kinTaleCommentAuthorLabel(comment)
    val name = comment.authorDisplayName?.trim().orEmpty()
    return if (name.isNotEmpty() && comment.authorNameIsPerson != false) "$name (you)" else "You"
}

/**
 * The letter on the composer and on the reader's own comments: the name the
 * server gave the reader's own comments when it named the person, else the
 * header's letter. One person, one letter, as on the web portal.
 */
internal fun ownKinTaleCommentInitial(comments: List<KinTaleComment>, viewer: KinTaleViewer): String {
    val ownName = comments.firstOrNull {
        isOwnKinTaleComment(it, viewer.uid) && it.authorNameIsPerson != false && !it.authorDisplayName.isNullOrBlank()
    }?.authorDisplayName
    return avatarInitial(ownName ?: viewer.name)
}

/** The letter on a comment's avatar: the author's name, never "(you)" or the "You" word. */
internal fun kinTaleCommentInitial(comment: KinTaleComment, viewerUid: String?, ownInitial: String): String {
    val name = comment.authorDisplayName?.trim().orEmpty()
    return when {
        comment.authorRole == CommentAuthorRole.Admin -> avatarInitial(name.ifEmpty { "Auntie" })
        comment.authorRole == CommentAuthorRole.Guest || !comment.guestName.isNullOrBlank() ->
            avatarInitial(name.ifEmpty { comment.guestName?.trim()?.ifEmpty { null } ?: "Guest" })
        isOwnKinTaleComment(comment, viewerUid) && (name.isEmpty() || comment.authorNameIsPerson == false) -> ownInitial
        else -> avatarInitial(name.ifEmpty { "Kinfolk" })
    }
}

/** Avatar colour: the reader's own rows take the composer's (and header's) tribe gradient; other rows cycle three. */
enum class KinTaleAvatarTone { Me, C1, C2, C3 }

internal fun kinTaleCommentAvatarTone(comment: KinTaleComment, viewerUid: String?, index: Int): KinTaleAvatarTone =
    if (isOwnKinTaleComment(comment, viewerUid)) {
        KinTaleAvatarTone.Me
    } else {
        listOf(KinTaleAvatarTone.C1, KinTaleAvatarTone.C2, KinTaleAvatarTone.C3)[index.mod(3)]
    }

private val purpleToCoral = Brush.linearGradient(
    colors = listOf(KinfolkBrand.FamilyPurple, KinfolkBrand.SnuggleCoral),
    start = Offset.Zero,
    end = Offset(400f, 400f),
)

private fun KinTaleAvatarTone.brush(): Brush = when (this) {
    KinTaleAvatarTone.Me -> KinfolkGradients.tribe
    KinTaleAvatarTone.C1 -> KinfolkGradients.orangeToPink
    KinTaleAvatarTone.C2 -> KinfolkGradients.tealToPurple
    KinTaleAvatarTone.C3 -> purpleToCoral
}

/** Round initial avatar for a comment row or the composer. Tagged by tone for tests. */
@Composable
internal fun KinTaleCommentAvatar(initial: String, tone: KinTaleAvatarTone, modifier: Modifier = Modifier) {
    val type = LocalKinfolkTypography.current
    Box(
        modifier = modifier
            .size(36.dp)
            .clip(CircleShape)
            .background(tone.brush())
            .testTag("kintale-avatar-${tone.name.lowercase()}"),
        contentAlignment = Alignment.Center,
    ) {
        Text(initial, style = type.heritageTitle.copy(fontSize = 15.sp, color = Color.White))
    }
}
