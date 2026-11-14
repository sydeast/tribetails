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
    /** #1874: a reply from the office. */
    onOpenMessages: () -> Unit = {},
    /** The bell's count: the server's number on load, one less per tap. */
    onUnreadCount: (Int) -> Unit = {},
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

    suspend fun load(before: Long?) {
        try {
            val page = portalApi.listMyNotifications(kinfolkId = kinfolkId, limit = PAGE_SIZE, before = before)
            items = if (before == null) page.items else items.orEmpty() + page.items
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

    fun open(item: NotificationItem) {
        if (item.unread) {
            val readAt = nowMs()
            items = items?.map { if (it.id == item.id) it.copy(readAtMs = readAt) else it }
            unread = (unread - 1).coerceAtLeast(0)
            onUnreadCount(unread)
            scope.launch {
                try {
                    portalApi.markNotificationRead(item.id)
                } catch (c: CancellationException) {
                    throw c
                } catch (_: Throwable) {
                    // The next load shows the row unread again, which is the truth.
                }
            }
        }
        when (val target = notificationTargetOf(item)) {
            is NotificationTarget.Visit -> onOpenVisit(target.visitId, target.batchId)
            is NotificationTarget.BookingRequest -> onOpenBookingRequest(target.batchId)
            NotificationTarget.Schedule -> onOpenSchedule()
            is NotificationTarget.Invoice -> onOpenInvoice(target.invoiceId)
            is NotificationTarget.KinTale -> onOpenKinTale(target.taleId)
            NotificationTarget.Messages -> onOpenMessages()
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
                        NotificationRow(item = item, nowMs = nowMs(), onClick = { open(item) })
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

@Composable
private fun NotificationRow(item: NotificationItem, nowMs: Long, onClick: () -> Unit) {
    val type = LocalKinfolkTypography.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
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
                Text(item.description, style = type.sansMeta.copy(color = KinfolkBrand.NavyMuted))
            }
            // #2030: the office's note on its answer, as written.
            item.householdNote?.let { note ->
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
