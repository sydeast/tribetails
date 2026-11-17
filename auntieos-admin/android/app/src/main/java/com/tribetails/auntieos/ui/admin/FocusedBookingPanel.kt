package com.tribetails.auntieos.ui.admin

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.unit.dp
import com.composables.icons.lucide.CircleAlert
import com.composables.icons.lucide.CircleCheckBig
import com.composables.icons.lucide.Lucide
import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.domain.storedBusinessLocal
import com.tribetails.auntieos.ui.admin.scheduling.FOCUSED_BOOKING_FAILED_TITLE
import com.tribetails.auntieos.ui.admin.scheduling.FOCUSED_BOOKING_GONE_BODY
import com.tribetails.auntieos.ui.admin.scheduling.FOCUSED_BOOKING_GONE_TITLE
import com.tribetails.auntieos.ui.admin.scheduling.FOCUSED_BOOKING_LOOKING_UP
import com.tribetails.auntieos.ui.admin.scheduling.FOCUSED_BOOKING_TITLE
import com.tribetails.auntieos.ui.admin.scheduling.FocusedBookingStage
import com.tribetails.auntieos.ui.admin.scheduling.LocalBusinessZone
import com.tribetails.auntieos.ui.admin.scheduling.focusedBookingBody
import com.tribetails.auntieos.ui.components.AuntieBanner
import com.tribetails.auntieos.ui.components.AuntieBannerTone
import com.tribetails.auntieos.ui.components.AuntieLinearProgress
import com.tribetails.auntieos.ui.components.AuntieStatusPill
import com.tribetails.auntieos.ui.components.AuntieStatusTone
import com.tribetails.auntieos.ui.components.GhostButton
import com.tribetails.auntieos.ui.components.GlassSurface
import com.tribetails.auntieos.ui.components.statusLabel
import com.tribetails.auntieos.ui.theme.AuntieTheme
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** #2367: the test tag on every highlighted visit card of a notice's booking. */
internal const val FOCUSED_BOOKING_VISIT_TAG = "focusedBookingVisit"

/** Whether Bookings draws [FocusedBookingPanel] for [stage]: stage 3 only. */
internal fun focusedBookingPanelShown(stage: FocusedBookingStage): Boolean = when (stage) {
    FocusedBookingStage.LookingUp,
    FocusedBookingStage.Gone,
    is FocusedBookingStage.Booked,
    is FocusedBookingStage.LookupFailed -> true
    FocusedBookingStage.None,
    FocusedBookingStage.Waiting,
    FocusedBookingStage.OpenCard -> false
}

private val VISIT_WHEN = DateTimeFormatter.ofPattern("EEE, MMM d 'at' HH:mm", Locale.US)

/** "Wed, Dec 3 at 09:00" on the business clock (auntieOS reads 24h, #1828), or "Date pending". Pure; unit-tested. */
internal fun focusedVisitWhen(session: KinCareSession, zone: ZoneId): String =
    storedBusinessLocal(session.startTime, zone)?.format(VISIT_WHEN) ?: "Date pending"

/**
 * #2367: stage 3 of a notice's Open on Bookings, for a booking the request
 * queue no longer holds.
 *
 * Android's Bookings list draws this app's own `enhanced_bookings`, and a
 * booking made in MyTribe and approved has none: its visits are KinCare visits
 * only. So the booking's visits are drawn here, under the banner, each as a
 * highlighted card that opens its own KinCare detail, and the banner's count
 * is the number of cards drawn.
 */
@Composable
internal fun FocusedBookingPanel(
    stage: FocusedBookingStage,
    catalog: ServiceCatalog,
    onOpenVisit: (sessionId: String) -> Unit,
    onDismiss: () -> Unit,
    onRetry: () -> Unit,
) {
    when (stage) {
        FocusedBookingStage.LookingUp -> Column(
            modifier = Modifier.fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(FOCUSED_BOOKING_LOOKING_UP, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textDim)
            AuntieLinearProgress(modifier = Modifier.fillMaxWidth())
        }
        FocusedBookingStage.Gone -> AuntieBanner(
            tone = AuntieBannerTone.Info,
            title = FOCUSED_BOOKING_GONE_TITLE,
            icon = Lucide.CircleAlert,
            onDismiss = onDismiss,
        ) {
            Text(FOCUSED_BOOKING_GONE_BODY, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textDim)
        }
        is FocusedBookingStage.LookupFailed -> AuntieBanner(
            tone = AuntieBannerTone.Error,
            title = FOCUSED_BOOKING_FAILED_TITLE,
            icon = Lucide.CircleAlert,
            onDismiss = onDismiss,
            trailing = { GhostButton(label = "Retry", onClick = onRetry) },
        ) {
            if (stage.message.isNotBlank()) {
                Text(stage.message, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.error)
            }
        }
        is FocusedBookingStage.Booked -> Column(
            modifier = Modifier.fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            AuntieBanner(
                tone = AuntieBannerTone.Info,
                title = FOCUSED_BOOKING_TITLE,
                icon = Lucide.CircleCheckBig,
                onDismiss = onDismiss,
            ) {
                Text(
                    focusedBookingBody(stage.sessions.size),
                    style = AuntieTheme.typography.bodySmall,
                    color = AuntieTheme.colors.textDim,
                )
            }
            val firstCard = remember { BringIntoViewRequester() }
            LaunchedEffect(stage.sessions.firstOrNull()?.id) { runCatching { firstCard.bringIntoView() } }
            stage.sessions.forEachIndexed { i, session ->
                FocusedVisitCard(
                    session = session,
                    catalog = catalog,
                    onClick = { onOpenVisit(session.id) },
                    modifier = if (i == 0) Modifier.bringIntoViewRequester(firstCard) else Modifier,
                )
            }
        }
        FocusedBookingStage.None, FocusedBookingStage.Waiting, FocusedBookingStage.OpenCard -> Unit
    }
}

@Composable
private fun FocusedVisitCard(
    session: KinCareSession,
    catalog: ServiceCatalog,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = AuntieTheme.colors
    val zone = LocalBusinessZone.current
    val status = session.status.uppercase()
    val tone = when (status) {
        "CANCELLED" -> AuntieStatusTone.Muted
        "COMPLETED" -> AuntieStatusTone.Purple
        else -> AuntieStatusTone.Teal
    }
    GlassSurface(
        cornerRadius = 18.dp,
        modifier = modifier
            .fillMaxWidth()
            .testTag(FOCUSED_BOOKING_VISIT_TAG)
            .semantics { selected = true }
            .border(BorderStroke(2.dp, c.accent), RoundedCornerShape(18.dp))
            .clickable(onClick = onClick),
    ) {
        Row(
            modifier = Modifier.padding(14.dp).fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Column(Modifier.weight(1f)) {
                Text(
                    session.serviceType.takeIf { it.isNotBlank() }?.let { catalog.nameOf(it) } ?: "KinCare visit",
                    style = AuntieTheme.typography.titleMedium,
                    color = c.textPrimary,
                )
                Text(focusedVisitWhen(session, zone), style = AuntieTheme.typography.bodySmall, color = c.textDim)
            }
            AuntieStatusPill(
                label = statusLabel(status).replaceFirstChar { it.uppercase() },
                tone = tone,
                compact = true,
            )
        }
    }
}
