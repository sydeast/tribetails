package com.kinfolk.portal.screens.notifications

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.kinfolk.portal.components.GlassCard
import com.kinfolk.portal.components.KinButton
import com.kinfolk.portal.components.KinSpinner
import com.kinfolk.portal.components.ScreenHeader
import com.kinfolk.portal.portal.NotificationItem
import com.kinfolk.portal.portal.NotificationTarget
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.portal.notificationTargetOf
import com.kinfolk.portal.theme.KinfolkBrand
import com.kinfolk.portal.theme.KinfolkSpacing
import com.kinfolk.portal.theme.LocalKinfolkTypography
import com.kinfolk.portal.util.relativeTime
import kotlin.coroutines.cancellation.CancellationException
import kotlin.time.Clock
import kotlinx.coroutines.launch

private const val PAGE_SIZE = 50

/**
 * The notifications list behind the header bell (#1316).
 *
 * Until this screen the bell opened Notification SETTINGS, so the one place a
 * household could see what the business had told them (a visit confirmed, an
 * invoice sent, a KinTale posted) did not exist in the app; the rows had been
 * written to `notifications/{id}` all along. Settings stay in the avatar menu.
 *
 * Reads `listMyNotifications`, newest first, a page at a time. A tap marks the
 * row read at once (the row, and the bell through [onUnreadCount]), tells the
 * server, then opens the thing the row is about. A failed mark is not surfaced:
 * the row comes back unread on the next load, which is the truth.
 *
 * Every wait has a cue: the spinner while the first page is out, the button's
 * own label while an older page is.
 */
@Composable
fun NotificationsListScreen(
    kinfolkId: String,
    portalApi: PortalApi,
    onOpenVisit: (visitId: String, batchId: String?) -> Unit = { _, _ -> },
    onOpenBookingRequest: (batchId: String) -> Unit = {},
    onOpenSchedule: () -> Unit = {},
    onOpenInvoice: (invoiceId: String) -> Unit = {},
    onOpenKinTale: (taleId: String) -> Unit = {},
    /** #1898: comments across several tales. */
    onOpenKinTales: () -> Unit = {},
    /** #1913: the Kin a notice is about, or the Kin tab when it is no longer listed. */
    onOpenKin: (kinId: String) -> Unit = {},
    onOpenKinList: () -> Unit = {},
    /** The household's own profile. */
    onOpenTribe: () -> Unit = {},
    /** #1874: a reply from the office. */
    onOpenMessages: () -> Unit = {},
    /**
     * The count the bell shows before its first live snapshot: the server's
     * number on load, one less per tap. Once the bell is live (#1833) it
     * counts for itself and this only keeps the starting number honest.
     */
    onUnreadCount: (Int) -> Unit = {},
    /**
     * #1833: moves when the bell's listener sees one of this person's rows
     * arrive or change. The newest page is read again, so the rows and the
     * bell's count move together; older pages already on screen stay.
     */
    liveRevision: Int = 0,
    /** #1833: a tapped row stops counting on the bell at once, ahead of the server... */
    onReadLocally: (notificationId: String) -> Unit = {},
    /** ...and counts again when the server refuses the read. */
    onReadRefused: (notificationId: String) -> Unit = {},
    /**
     * The entry a tapped push opened the list for: a push whose line was cut,
     * or whose notice carries the office's note, is read whole here. That row
     * is marked and brought into view. An id that is not among this
     * household's rows marks nothing.
     */
    openedEntryId: String? = null,
    nowMs: () -> Long = { Clock.System.now().toEpochMilliseconds() },
) {
    val type = LocalKinfolkTypography.current
    val scope = rememberCoroutineScope()

    var items by remember { mutableStateOf<List<NotificationItem>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var hasMore by remember { mutableStateOf(false) }
    var nextBefore by remember { mutableStateOf<Long?>(null) }
    var loadingMore by remember { mutableStateOf(false) }
    var unread by remember { mutableStateOf(0) }
    // #1833: true once "Show older" has added a page; the paging cursor then
    // belongs to the oldest row on screen and a re-read of the newest page must not move it.
    var pagedOlder by remember { mutableStateOf(false) }

    suspend fun load(before: Long?) {
        try {
            val page = portalApi.listMyNotifications(kinfolkId = kinfolkId, limit = PAGE_SIZE, before = before)
            items = if (before == null) page.items else items.orEmpty() + page.items
            pagedOlder = before != null
            hasMore = page.hasMore
            nextBefore = page.nextBefore
            unread = page.unreadCount
            onUnreadCount(page.unreadCount)
            error = null
        } catch (c: CancellationException) {
            throw c
        } catch (t: Throwable) {
            error = t.message ?: "Could not load notifications."
        }
    }

    LaunchedEffect(kinfolkId) { load(null) }
    // #1833: a row arrived or changed while the list is open. Quiet on
    // purpose: the rows stay on screen while the newest page is re-read, and a
    // failed re-read leaves them as they were (the first load reports its own).
    var seenRevision by remember { mutableStateOf(liveRevision) }
    LaunchedEffect(liveRevision) {
        if (liveRevision == seenRevision) return@LaunchedEffect
        seenRevision = liveRevision
        if (items == null) return@LaunchedEffect
        try {
            val page = portalApi.listMyNotifications(kinfolkId = kinfolkId, limit = PAGE_SIZE, before = null)
            // Read what is on screen now, not what was there before the call:
            // "Show older" may have added a page while this one was in flight.
            val shown = items ?: return@LaunchedEffect
            if (pagedOlder || loadingMore) {
                // The older pages stay underneath (or are on their way, asked
                // for with the cursor already held), and the cursor stays with
                // the oldest row on screen.
                items = mergeNewestPage(shown, page.items)
            } else {
                // Still on the first page: the fresh page replaces it whole and
                // brings its own cursor. Keeping the row the new notice pushed
                // off the page would list it twice after "Show older".
                items = page.items
                hasMore = page.hasMore
                nextBefore = page.nextBefore
            }
            unread = page.unreadCount
            onUnreadCount(page.unreadCount)
        } catch (c: CancellationException) {
            throw c
        } catch (_: Throwable) {
        }
    }

    fun open(item: NotificationItem) {
        if (item.unread) {
            val readAt = nowMs()
            items = items?.map { if (it.id == item.id) it.copy(readAtMs = readAt) else it }
            unread = (unread - 1).coerceAtLeast(0)
            onUnreadCount(unread)
            onReadLocally(item.id)
            scope.launch {
                try {
                    portalApi.markNotificationRead(item.id)
                } catch (c: CancellationException) {
                    throw c
                } catch (_: Throwable) {
                    // The row goes back on the bell, and the next load shows it
                    // unread again, which is the truth.
                    onReadRefused(item.id)
                }
            }
        }
        when (val target = notificationTargetOf(item)) {
            is NotificationTarget.Visit -> onOpenVisit(target.visitId, target.batchId)
            is NotificationTarget.BookingRequest -> onOpenBookingRequest(target.batchId)
            NotificationTarget.Schedule -> onOpenSchedule()
            is NotificationTarget.Invoice -> onOpenInvoice(target.invoiceId)
            is NotificationTarget.KinTale -> onOpenKinTale(target.taleId)
            NotificationTarget.KinTales -> onOpenKinTales()
            is NotificationTarget.Kin -> onOpenKin(target.kinId)
            NotificationTarget.KinList -> onOpenKinList()
            NotificationTarget.Household -> onOpenTribe()
            NotificationTarget.Messages -> onOpenMessages()
            // Only a tapped push names the list itself; a row never does.
            is NotificationTarget.Entry -> Unit
            NotificationTarget.None -> Unit
        }
    }

    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.m),
    ) {
        ScreenHeader(title = "Notifications")

        GlassCard(
            modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.m),
            contentPadding = PaddingValues(KinfolkSpacing.m),
        ) {
            Column {
                val list = items
                val failure = error
                when {
                    failure != null -> Text(
                        failure,
                        style = type.sansBody.copy(color = KinfolkBrand.SnuggleCoral),
                        modifier = Modifier.testTag("notificationsError"),
                    )
                    list == null -> Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.testTag("notificationsLoading"),
                    ) {
                        KinSpinner(size = 20.dp)
                        Spacer(Modifier.width(KinfolkSpacing.s))
                        Text("Loading your notifications…", style = type.sansMeta.copy(color = KinfolkBrand.NavyMuted))
                    }
                    list.isEmpty() -> Text(
                        "No notifications yet.",
                        style = type.sansBody.copy(color = KinfolkBrand.NavyMuted),
                        modifier = Modifier.testTag("notificationsEmpty"),
                    )
                    else -> list.forEachIndexed { i, item ->
                        if (i > 0) Box(Modifier.fillMaxWidth().height(1.dp).background(KinfolkBrand.NavyHairline))
                        NotificationRow(
                            item = item,
                            nowMs = nowMs(),
                            opened = item.id == openedEntryId,
                            onClick = { open(item) },
                        )
                    }
                }
                if (hasMore) {
                    Spacer(Modifier.height(KinfolkSpacing.m))
                    KinButton(
                        label = if (loadingMore) "Loading…" else "Show older",
                        enabled = !loadingMore,
                        modifier = Modifier.fillMaxWidth().testTag("notificationsOlder"),
                        onClick = {
                            scope.launch {
                                loadingMore = true
                                try {
                                    load(nextBefore)
                                } finally {
                                    loadingMore = false
                                }
                            }
                        },
                    )
                }
            }
        }
    }
}

/**
 * #1833: the newest page read again, laid over what is on screen. The fresh
 * rows come first, as the server ordered them; rows already shown that are
 * older than the fresh page stay underneath. A shown row the fresh page should
 * have held and did not (archived since, or about another tribe now) is gone.
 */
internal fun mergeNewestPage(shown: List<NotificationItem>, fresh: List<NotificationItem>): List<NotificationItem> {
    if (fresh.isEmpty()) return emptyList()
    val freshIds = fresh.map { it.id }.toSet()
    val oldestFresh = fresh.mapNotNull { it.createdAtMs }.minOrNull() ?: return fresh
    val older = shown.filter { it.id !in freshIds && (it.createdAtMs ?: Long.MAX_VALUE) < oldestFresh }
    return fresh + older
}
@Composable
private fun NotificationRow(item: NotificationItem, nowMs: Long, opened: Boolean = false, onClick: () -> Unit) {
    val type = LocalKinfolkTypography.current
    // The entry a tapped push opened the list for is tinted, read out as
    // selected, and scrolled to once.
    val bringIntoView = remember { BringIntoViewRequester() }
    if (opened) LaunchedEffect(item.id) { bringIntoView.bringIntoView() }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .then(
                if (opened) {
                    Modifier
                        .bringIntoViewRequester(bringIntoView)
                        .background(KinfolkBrand.KinfolkOrange.copy(alpha = 0.12f))
                        .semantics { selected = true }
                } else {
                    Modifier
                },
            )
            .clickable { onClick() }
            .padding(vertical = 12.dp, horizontal = 4.dp)
            .testTag("notificationRow-${item.id}"),
        verticalAlignment = Alignment.Top,
    ) {
        Box(
            modifier = Modifier
                .padding(top = 6.dp)
                .size(8.dp)
                .background(if (item.unread) KinfolkBrand.SnuggleCoral else KinfolkBrand.NavyHairline, CircleShape)
                .testTag(if (item.unread) "unread-${item.id}" else "read-${item.id}"),
        )
        Spacer(Modifier.width(KinfolkSpacing.s))
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                item.title.ifBlank { item.key },
                style = type.sansLabel.copy(
                    fontWeight = if (item.unread) FontWeight.SemiBold else FontWeight.Medium,
                    color = KinfolkBrand.Navy,
                ),
            )
            if (item.description.isNotBlank()) {
                Text(
                    item.description,
                    style = type.sansMeta.copy(color = KinfolkBrand.NavyMuted),
                    modifier = Modifier.testTag("notificationLine-${item.id}"),
                )
            }
            // #2368: the rest of a cut push, as text.
            item.fullMessage?.let { message ->
                Text(
                    message,
                    style = type.sansMeta.copy(color = KinfolkBrand.Navy),
                    modifier = Modifier.testTag("fullMessage-${item.id}"),
                )
            }
            // #2030: the office's note on its answer, as written.
            item.rowNote?.let { note ->
                Text(
                    note,
                    style = type.sansMeta.copy(color = KinfolkBrand.Navy),
                    modifier = Modifier.testTag("householdNote-${item.id}"),
                )
            }
        }
        Spacer(Modifier.width(KinfolkSpacing.s))
        Text(
            relativeTime(item.createdAtMs, nowMs),
            style = type.sansMeta.copy(color = KinfolkBrand.NavyMuted),
            maxLines = 1,
        )
    }
}
