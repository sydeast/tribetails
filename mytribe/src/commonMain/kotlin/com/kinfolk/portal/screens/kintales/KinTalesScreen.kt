package com.kinfolk.portal.screens.kintales

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.PhotoLibrary
import androidx.compose.material.icons.outlined.FavoriteBorder
import androidx.compose.material.icons.outlined.IosShare
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.kinfolk.portal.components.EmptyState
import com.kinfolk.portal.components.GlassCard
import com.kinfolk.portal.components.KinButton
import com.kinfolk.portal.components.KinChip
import com.kinfolk.portal.components.KinGhostButton
import com.kinfolk.portal.components.KinSpinner
import com.kinfolk.portal.components.KinfolkRemoteImage
import com.kinfolk.portal.components.ScreenHeader
import com.kinfolk.portal.nav.isWideShell
import com.kinfolk.portal.portal.CommentAuthorRole
import com.kinfolk.portal.portal.KinTale
import com.kinfolk.portal.portal.KinTaleChecklistItem
import com.kinfolk.portal.portal.KinTaleComment
import com.kinfolk.portal.portal.KinTaleReaction
import com.kinfolk.portal.portal.KinTaleMedia
import com.kinfolk.portal.portal.KinTaleThumb
import com.kinfolk.portal.portal.KinTalesResult
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.text.richTextToAnnotatedString
import com.kinfolk.portal.theme.KinfolkBrand
import com.kinfolk.portal.theme.KinfolkShapes
import com.kinfolk.portal.theme.KinfolkSpacing
import com.kinfolk.portal.theme.LocalKinfolkTypography
import com.kinfolk.portal.util.clockTime
import com.kinfolk.portal.util.relativeTime
import kotlinx.coroutines.launch

/** Filter labels are user-facing; the enum constants stay the stable keys. */
private enum class KinTalesFilter(val label: String) { All("All"), Lore("Notes"), Gallery("Gallery") }

/**
 * KinTales feed, styled per ui-ideas/mytribe-kintales-2026-05-31.html: serif
 * page head ("Your KinTales"), glass tab row (All / Notes / Gallery KinChips),
 * tale cards with mono bylines + photo strips + comment threads, and a ghost
 * Load More. Wide (>= 880dp, shell breakpoint): two-column masonry-ish feed
 * (round-robin via [splitIntoColumns]); narrow: one column.
 */
@Composable
fun KinTalesScreen(
    familyName: String,
    kinfolkId: String,
    portalApi: PortalApi,
) {
    val type = LocalKinfolkTypography.current
    val scope = rememberCoroutineScope()

    var filter by remember { mutableStateOf(KinTalesFilter.All) }
    var tales by remember { mutableStateOf<List<KinTale>?>(null) }
    var hasMore by remember { mutableStateOf(false) }
    var loadingMore by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(kinfolkId) {
        try {
            val res: KinTalesResult = portalApi.getMyKinTales(kinfolkId = kinfolkId)
            tales = res.tales
            hasMore = res.hasMore
            error = null
        } catch (t: Throwable) {
            error = t.message ?: "Could not load KinTales"
        }
    }

    val filtered = remember(tales, filter) {
        when (filter) {
            KinTalesFilter.All -> tales
            KinTalesFilter.Lore -> tales?.filter { it.mediaIds.isEmpty() }
            KinTalesFilter.Gallery -> tales?.filter { it.mediaIds.isNotEmpty() }
        }
    }

    BoxWithConstraints(modifier = Modifier.fillMaxSize()) {
        val wide = isWideShell(maxWidth.value)
        Column(
            modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.m),
        ) {
            // Page head (mockup hero-greet): mono kicker + serif title.
            Column(modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l)) {
                Text("FROM YOUR AUNTIES", style = type.sansMeta.copy(color = KinfolkBrand.KinfolkOrange))
                Spacer(Modifier.height(KinfolkSpacing.xs))
                Text(
                    buildAnnotatedString {
                        append("Your ")
                        withStyle(SpanStyle(color = KinfolkBrand.PackPink)) { append("KinTales") }
                    },
                    style = type.heritageDisplay.copy(fontWeight = FontWeight.Normal),
                )
            }

            // Filter tab row (mockup `.tabs`): glass pill container + KinChips.
            Row(
                modifier = Modifier
                    .padding(horizontal = KinfolkSpacing.l)
                    .clip(KinfolkShapes.card)
                    .background(KinfolkBrand.GlassSurfaceDim)
                    .padding(KinfolkSpacing.xs),
                horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.xs),
            ) {
                KinTalesFilter.entries.forEach { f ->
                    KinChip(
                        label = f.label,
                        selected = filter == f,
                        onClick = { filter = f },
                    )
                }
            }

            when {
                error != null -> EmptyState(
                    title = "Couldn't load KinTales",
                    message = error ?: "",
                )
                tales == null -> Box(
                    modifier = Modifier.fillMaxWidth().padding(KinfolkSpacing.l),
                    contentAlignment = Alignment.Center,
                ) { KinSpinner() }
                filtered.isNullOrEmpty() -> EmptyState(
                    title = if (filter == KinTalesFilter.All) "No KinTales yet" else "Nothing in ${filter.label} yet",
                    message = "Your Auntie's daily updates and photos from visits will appear here.",
                )
                else -> {
                    val columns = talesColumnCount(wide)
                    if (columns == 1) {
                        Column(
                            modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l),
                            verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.m),
                        ) {
                            filtered!!.forEach { tale -> KinTaleCard(tale, kinfolkId, portalApi) }
                        }
                    } else {
                        Row(
                            modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l),
                            horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.l),
                            verticalAlignment = Alignment.Top,
                        ) {
                            splitIntoColumns(filtered!!, columns).forEach { columnTales ->
                                Column(
                                    modifier = Modifier.weight(1f),
                                    verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.m),
                                ) {
                                    columnTales.forEach { tale -> KinTaleCard(tale, kinfolkId, portalApi) }
                                }
                            }
                        }
                    }
                }
            }
            if (hasMore && tales != null) {
                Box(modifier = Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                    KinGhostButton(
                        label = if (loadingMore) "Loading…" else "Load More",
                        onClick = {
                            val cursor = tales?.lastOrNull()?.sentAtMs ?: return@KinGhostButton
                            loadingMore = true
                            scope.launch {
                                try {
                                    val next = portalApi.getMyKinTales(kinfolkId = kinfolkId, before = cursor)
                                    tales = (tales.orEmpty()) + next.tales
                                    hasMore = next.hasMore
                                } catch (t: Throwable) {
                                    error = t.message ?: "Could not load more"
                                } finally {
                                    loadingMore = false
                                }
                            }
                        },
                        enabled = !loadingMore,
                    )
                }
            }
            Spacer(Modifier.height(KinfolkSpacing.l))
        }
    }
}

@Composable
private fun KinTaleCard(
    tale: KinTale,
    kinfolkId: String,
    portalApi: PortalApi,
    modifier: Modifier = Modifier,
) {
    val type = LocalKinfolkTypography.current
    var expanded by remember(tale.id) { mutableStateOf(false) }
    var media by remember(tale.id) { mutableStateOf<List<KinTaleMedia>?>(null) }
    var mediaError by remember(tale.id) { mutableStateOf<String?>(null) }
    var loadAttempt by remember(tale.id) { mutableStateOf(0) }
    var showShareModal by remember(tale.id) { mutableStateOf(false) }

    LaunchedEffect(expanded, loadAttempt, tale.id) {
        if (!expanded || media != null) return@LaunchedEffect
        try {
            mediaError = null
            media = portalApi.getMyKinTaleMedia(kinfolkId = kinfolkId, taleId = tale.id)
        } catch (t: Throwable) {
            mediaError = t.message ?: "Could not load photos"
        }
    }

    GlassCard(
        modifier = modifier.fillMaxWidth(),
        contentPadding = PaddingValues(KinfolkSpacing.l),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = tale.authorDisplayName ?: "Auntie",
                        style = type.heritageTitle,
                    )
                    Text(
                        text = relativeTime(tale.sentAtMs),
                        style = type.sansMeta,
                    )
                }
                IconButton(onClick = { showShareModal = true }) {
                    Icon(
                        imageVector = Icons.Outlined.IosShare,
                        contentDescription = if (tale.shared) "Share (already shared)" else "Share",
                        tint = if (tale.shared) KinfolkBrand.KinTeal else KinfolkBrand.NavyMuted,
                    )
                }
            }
            if (tale.body.isNotBlank()) {
                Text(text = tale.body, style = type.sansBody.copy(color = KinfolkBrand.NavySoft))
            }
            if (tale.thumbs.isNotEmpty()) {
                KinTaleThumbStrip(thumbs = tale.thumbs)
            }
            if (tale.mediaIds.isNotEmpty()) {
                MediaBadge(
                    count = tale.mediaIds.size,
                    expanded = expanded,
                    onClick = { expanded = !expanded },
                )
                if (expanded) {
                    when {
                        mediaError != null -> Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
                        ) {
                            Text(
                                text = mediaError ?: "",
                                style = type.sansMeta.copy(color = KinfolkBrand.PackPink),
                                modifier = Modifier.weight(1f),
                            )
                            KinGhostButton(label = "Retry", onClick = {
                                media = null
                                loadAttempt++
                            })
                        }
                        media == null -> Box(
                            modifier = Modifier.fillMaxWidth().padding(KinfolkSpacing.s),
                            contentAlignment = Alignment.CenterStart,
                        ) { KinSpinner(size = 20.dp) }
                        media!!.isEmpty() -> Text(
                            text = "Photos no longer available. They may have expired.",
                            style = type.sansMeta.copy(color = KinfolkBrand.NavyMuted),
                        )
                        else -> Row(
                            modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                            horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
                        ) {
                            media!!.forEach { item ->
                                KinfolkRemoteImage(
                                    url = item.url,
                                    contentDescription = "Photo from ${tale.authorDisplayName ?: "Auntie"}",
                                    modifier = Modifier.size(140.dp),
                                )
                            }
                        }
                    }
                }
            }
            KinTaleVisitFacts(tale)
            if (tale.checklist.isNotEmpty()) {
                KinTaleChecklistChips(tale.checklist)
            }
            if (tale.gpsRoute.isNotEmpty()) {
                com.kinfolk.portal.components.RouteMap(
                    route = tale.gpsRoute,
                    distanceMeters = tale.gpsDistanceMeters,
                    durationSeconds = tale.gpsDurationSeconds,
                )
            }
            KinTaleReactionRow(taleId = tale.id, kinfolkId = kinfolkId, portalApi = portalApi)
            KinTaleComments(taleId = tale.id, kinfolkId = kinfolkId, portalApi = portalApi)
        }
    }

    if (showShareModal) {
        ShareKinTaleModal(
            familyId = kinfolkId,
            kinTaleId = tale.id,
            portalApi = portalApi,
            onDismiss = { showShareModal = false },
        )
    }
}

/**
 * Visit facts (task-25, P4): when the Auntie arrived / departed, in the
 * kinfolk's own local time zone (`clockTime`, `util/RelativeTime.kt` — the
 * first clock-time formatter on this platform; ScheduleScreen.kt's own raw-
 * ISO render for the same underlying fields is a pre-existing rough edge in
 * a secondary panel, not a convention this task extends). Either half can be
 * absent (a departure that was never stamped is common) or unparseable
 * (never crashes, never a fabricated time); an absent half is simply
 * omitted. Neither recorded means no row at all.
 */
@Composable
private fun KinTaleVisitFacts(tale: KinTale) {
    val type = LocalKinfolkTypography.current
    val parts = listOfNotNull(
        clockTime(tale.arrivedAtIso)?.let { "Arrived $it" },
        clockTime(tale.departedAtIso)?.let { "Departed $it" },
    )
    if (parts.isEmpty()) return
    Text(text = parts.joinToString(" · "), style = type.sansMeta.copy(color = KinfolkBrand.NavyMuted))
}

/**
 * Task checklist (task-25, P4): checked items only. `tale.checklist` already
 * carries only what the Auntie's app recorded as done — this composable does
 * not, and cannot, infer what was left undone (see getMyKinTales.ts's own
 * doc comment); it just renders what's there.
 */
@Composable
private fun KinTaleChecklistChips(items: List<KinTaleChecklistItem>) {
    val type = LocalKinfolkTypography.current
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(text = "CARE TASKS DONE THIS VISIT", style = type.sansMeta.copy(color = KinfolkBrand.NavyMuted))
        Row(
            modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            items.forEach { item ->
                GlassCard(
                    modifier = Modifier.testTag("kinTaleChecklistChip"),
                    shape = KinfolkShapes.pill,
                    contentPadding = PaddingValues(horizontal = KinfolkSpacing.s, vertical = 4.dp),
                ) {
                    Text(text = item.text, style = type.sansMeta.copy(color = KinfolkBrand.KinTeal))
                }
            }
        }
    }
}

/**
 * The mockup's heart + "You and 2 others loved this" line
 * (ui-ideas/mytribe-kintales-2026-05-31.html:348), clickable to toggle the
 * caller's own reaction. Mirrors [KinTaleComments]'s own load-on-mount +
 * local-state pattern. Optimistic: flips loved + count locally on tap,
 * reconciles with the server's response once it lands (or rolls back to
 * the pre-tap state on failure) so the button never feels laggy.
 */
@Composable
private fun KinTaleReactionRow(
    taleId: String,
    kinfolkId: String,
    portalApi: PortalApi,
) {
    val type = LocalKinfolkTypography.current
    val scope = rememberCoroutineScope()
    var reaction by remember(taleId) { mutableStateOf<KinTaleReaction?>(null) }
    var toggling by remember(taleId) { mutableStateOf(false) }

    LaunchedEffect(taleId, kinfolkId) {
        try {
            reaction = portalApi.getKinTaleReaction(kinfolkId = kinfolkId, taleId = taleId)
        } catch (_: Throwable) {
            // Best-effort — a missing reaction row is a minor cosmetic gap,
            // not worth a full error state the way a failed comment load is.
        }
    }

    val current = reaction ?: return
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        IconButton(
            enabled = !toggling,
            onClick = {
                val before = current
                reaction = KinTaleReaction(
                    loved = !before.loved,
                    loveCount = if (before.loved) before.loveCount - 1 else before.loveCount + 1,
                )
                toggling = true
                scope.launch {
                    try {
                        reaction = portalApi.toggleKinTaleLove(kinfolkId = kinfolkId, taleId = taleId)
                    } catch (_: Throwable) {
                        reaction = before
                    } finally {
                        toggling = false
                    }
                }
            },
        ) {
            Icon(
                imageVector = if (current.loved) Icons.Filled.Favorite else Icons.Outlined.FavoriteBorder,
                contentDescription = if (current.loved) "Unlove this KinTale" else "Love this KinTale",
                tint = if (current.loved) KinfolkBrand.PackPink else KinfolkBrand.NavyMuted,
            )
        }
        Text(text = kinTaleLoveLine(current), style = type.sansMeta)
    }
}

/** "You and 2 others loved this" / "You loved this" / "3 people loved this" /
 *  "Be the first to love this" — mirrors kinTalesApi.ts's `loveLine` exactly. */
internal fun kinTaleLoveLine(reaction: KinTaleReaction): String {
    val (loved, loveCount) = reaction
    if (loved) {
        val others = loveCount - 1
        return when {
            others <= 0 -> "You loved this"
            others == 1 -> "You and 1 other loved this"
            else -> "You and $others others loved this"
        }
    }
    return when {
        loveCount == 0 -> "Be the first to love this"
        loveCount == 1 -> "1 person loved this"
        else -> "$loveCount people loved this"
    }
}

@Composable
private fun KinTaleComments(
    taleId: String,
    kinfolkId: String,
    portalApi: PortalApi,
) {
    val type = LocalKinfolkTypography.current
    val scope = rememberCoroutineScope()
    var comments by remember(taleId) { mutableStateOf<List<KinTaleComment>?>(null) }
    var loadError by remember(taleId) { mutableStateOf<String?>(null) }
    var topInput by remember(taleId) { mutableStateOf("") }
    var replyParentId by remember(taleId) { mutableStateOf<String?>(null) }
    var replyInput by remember(taleId) { mutableStateOf("") }
    var posting by remember(taleId) { mutableStateOf(false) }
    var postError by remember(taleId) { mutableStateOf<String?>(null) }

    suspend fun reload() {
        try {
            loadError = null
            comments = portalApi.getMyKinTaleComments(kinfolkId = kinfolkId, taleId = taleId)
        } catch (t: Throwable) {
            loadError = t.message ?: "Could not load comments."
        }
    }

    LaunchedEffect(taleId, kinfolkId) { reload() }

    Spacer(Modifier.height(KinfolkSpacing.s))
    val count = comments?.size ?: 0
    Text("Comments ($count)", style = type.sansMeta)

    when {
        loadError != null -> Text(
            loadError ?: "",
            style = type.sansMeta.copy(color = KinfolkBrand.PackPink),
        )
        comments == null -> KinSpinner(size = 20.dp)
        comments!!.isEmpty() -> Text(
            "Be the first to say something nice.",
            style = type.sansMeta.copy(color = KinfolkBrand.NavyMuted),
        )
        else -> {
            val all = comments!!
            val topLevel = all.filter { it.parentCommentId.isNullOrBlank() }
                .sortedBy { it.createdAtMs ?: 0L }
            val repliesByParent = all
                .filter { !it.parentCommentId.isNullOrBlank() }
                .groupBy { it.parentCommentId!! }
            Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
                topLevel.forEach { parent ->
                    CommentRow(comment = parent, indent = false, onReply = {
                        replyParentId = parent.id
                        replyInput = ""
                    })
                    repliesByParent[parent.id].orEmpty()
                        .sortedBy { it.createdAtMs ?: 0L }
                        .forEach { reply ->
                            CommentRow(comment = reply, indent = true, onReply = null)
                        }
                    if (replyParentId == parent.id) {
                        ReplyComposer(
                            value = replyInput,
                            onValueChange = { replyInput = it },
                            disabled = posting,
                            onSubmit = {
                                val body = replyInput.trim()
                                if (body.isBlank()) {
                                    postError = "Reply cannot be empty."
                                    return@ReplyComposer
                                }
                                scope.launch {
                                    posting = true
                                    postError = null
                                    try {
                                        portalApi.addKinTaleComment(
                                            taleId = taleId,
                                            body = body,
                                            parentCommentId = parent.id,
                                            kinfolkId = kinfolkId,
                                        )
                                        replyInput = ""
                                        replyParentId = null
                                        reload()
                                    } catch (t: Throwable) {
                                        postError = t.message ?: "Could not post reply."
                                    } finally {
                                        posting = false
                                    }
                                }
                            },
                            onCancel = { replyParentId = null; replyInput = "" },
                        )
                    }
                }
            }
        }
    }

    Spacer(Modifier.height(KinfolkSpacing.xs))
    OutlinedTextField(
        value = topInput,
        onValueChange = { topInput = it },
        placeholder = { Text("Say something nice…") },
        minLines = 2,
        enabled = !posting,
        modifier = Modifier.fillMaxWidth(),
    )
    if (postError != null) {
        Text(postError!!, style = type.sansMeta.copy(color = KinfolkBrand.PackPink))
    }
    KinButton(
        label = if (posting) "Posting…" else "Post Comment",
        onClick = {
            val body = topInput.trim()
            if (body.isBlank()) {
                postError = "Comment cannot be empty."
                return@KinButton
            }
            scope.launch {
                posting = true
                postError = null
                try {
                    portalApi.addKinTaleComment(
                        taleId = taleId,
                        body = body,
                        kinfolkId = kinfolkId,
                    )
                    topInput = ""
                    reload()
                } catch (t: Throwable) {
                    postError = t.message ?: "Could not post comment."
                } finally {
                    posting = false
                }
            }
        },
        enabled = !posting && topInput.isNotBlank(),
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun CommentRow(
    comment: KinTaleComment,
    indent: Boolean,
    onReply: (() -> Unit)?,
) {
    val type = LocalKinfolkTypography.current
    val start = if (indent) KinfolkSpacing.l else 0.dp
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = start),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        val authorLabel = when (comment.authorRole) {
            CommentAuthorRole.Admin -> "Auntie"
            CommentAuthorRole.Guest -> "${comment.guestName ?: "Guest"} (guest)"
            CommentAuthorRole.Kinfolk -> comment.authorDisplayName ?: "Kinfolk"
        }
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(authorLabel, style = type.sansLabel.copy(fontWeight = FontWeight.SemiBold))
            Text(relativeTime(comment.createdAtMs), style = type.sansMeta)
        }
        Text(richTextToAnnotatedString(comment.body), style = type.sansBody.copy(color = KinfolkBrand.NavySoft))
        if (onReply != null) {
            Text(
                "Reply",
                style = type.sansMeta.copy(color = KinfolkBrand.KinTeal),
                modifier = Modifier.clickable { onReply() },
            )
        }
    }
}

@Composable
private fun ReplyComposer(
    value: String,
    onValueChange: (String) -> Unit,
    disabled: Boolean,
    onSubmit: () -> Unit,
    onCancel: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = KinfolkSpacing.l),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        OutlinedTextField(
            value = value,
            onValueChange = onValueChange,
            placeholder = { Text("Write a reply…") },
            minLines = 2,
            enabled = !disabled,
            modifier = Modifier.fillMaxWidth(),
        )
        Row(
            horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
        ) {
            KinButton(
                label = "Reply",
                onClick = onSubmit,
                enabled = !disabled && value.isNotBlank(),
            )
            KinGhostButton(label = "Cancel", onClick = onCancel)
        }
    }
}

/** Mirrors kintales.css's `.sm.s1/.s2/.s3` tile tints, cycled by index. */
private val ThumbTileTints = listOf(
    KinfolkBrand.KinfolkOrange.copy(alpha = 0.16f),
    KinfolkBrand.PackPink.copy(alpha = 0.14f),
    KinfolkBrand.KinTeal.copy(alpha = 0.14f),
)

private const val THUMB_STRIP_MAX_TILES = 8
private val ThumbTileSize = 54.dp
private val ThumbTileCorner = 13.dp

/**
 * Photo-first preview strip (task-24, P3): up to 8 tiles from the list
 * response's `thumbs`, so the card shows media at feed-render time instead
 * of only after the kinfolk expands the gallery. Horizontally scrollable —
 * the same convention this screen's own expanded gallery row already uses
 * (below, in KinTaleCard) — rather than wrapping, so eight 54dp tiles never
 * need to shrink or clip to fit a phone's width.
 */
@Composable
private fun KinTaleThumbStrip(thumbs: List<KinTaleThumb>) {
    Row(
        modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(9.dp),
    ) {
        thumbs.take(THUMB_STRIP_MAX_TILES).forEachIndexed { i, t ->
            KinTaleThumbTile(thumb = t, tint = ThumbTileTints[i % ThumbTileTints.size])
        }
    }
}

@Composable
private fun KinTaleThumbTile(thumb: KinTaleThumb, tint: Color) {
    val isImage = thumb.contentType == null || thumb.contentType.startsWith("image/")
    Box(
        modifier = Modifier
            .testTag("kinTaleThumbTile")
            .size(ThumbTileSize)
            .clip(RoundedCornerShape(ThumbTileCorner))
            .background(tint),
        contentAlignment = Alignment.Center,
    ) {
        if (isImage) {
            KinfolkRemoteImage(
                url = thumb.url,
                contentDescription = null,
                modifier = Modifier.size(ThumbTileSize),
                cornerRadius = ThumbTileCorner,
            )
        } else {
            // No poster frame available for a video (fail loud, never fake —
            // a browser/client can't draw one for free) — the play glyph on
            // the tile's tint marks it as a video, distinct from the
            // gallery's camera glyph for a non-image (MediaBadge's icon and
            // KinTalesScreen.kt's expanded-gallery convention).
            Text(text = "▶️", fontSize = 20.sp)
        }
    }
}

/**
 * The one full-gallery control (task-24 follow-up). Was "N photos · view/hide" —
 * wrong on a tale whose media includes video (the same reason web's equivalent
 * button reads "View Gallery" instead of "View N photos", KinTales.tsx's
 * `galleryBlock`). Renamed so neither client calls this "photos" for a
 * video-carrying tale, and both now name it a gallery; the count stays
 * (parenthetical) since Compose has no separate footer count line the way
 * web's `.tcfoot .ct` does.
 */
@Composable
private fun MediaBadge(count: Int, expanded: Boolean, onClick: () -> Unit) {
    val type = LocalKinfolkTypography.current
    GlassCard(
        modifier = Modifier.clickable(onClick = onClick),
        shape = KinfolkShapes.pill,
        contentPadding = PaddingValues(horizontal = KinfolkSpacing.m, vertical = 6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.xs)) {
            Icon(
                imageVector = Icons.Filled.PhotoLibrary,
                contentDescription = null,
                tint = KinfolkBrand.PackPink,
                modifier = Modifier.height(16.dp),
            )
            Text(
                text = if (expanded) "Hide" else "View Gallery ($count)",
                style = type.sansMeta.copy(color = KinfolkBrand.PackPink),
            )
        }
    }
}
