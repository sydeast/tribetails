package com.kinfolk.portal.screens.schedule

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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.kinfolk.portal.components.GlassCard
import com.kinfolk.portal.portal.Booking
import com.kinfolk.portal.portal.BookingEnvelope
import com.kinfolk.portal.portal.EnvelopeStatus
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.screens.schedule.util.ReviewRow
import com.kinfolk.portal.theme.KinfolkBrand
import com.kinfolk.portal.theme.KinfolkSpacing
import com.kinfolk.portal.theme.LocalKinfolkTypography
import com.kinfolk.portal.util.relativeTime

/**
 * Envelope (Booking) detail. Resolves the [BookingEnvelope] from getMyBookings
 * by batchId, renders a rollup header plus the envelope-level note, then lists
 * each KinCare. Tapping a KinCare row drills into [KinCareDetailScreen]. Only
 * reached when the bookingEnvelope flag is ON.
 */
@Composable
fun BookingEnvelopeScreen(
    batchId: String,
    kinfolkId: String,
    portalApi: PortalApi,
    onBack: () -> Unit,
    onOpenKinCare: (visitId: String, batchId: String?) -> Unit = { _, _ -> },
) {
    val type = LocalKinfolkTypography.current
    var envelope by remember { mutableStateOf<BookingEnvelope?>(null) }
    var loadError by remember { mutableStateOf<String?>(null) }

    suspend fun reload() {
        try {
            val all = portalApi.getMyBookings(kinfolkId)
            envelope = all.envelopes.firstOrNull { it.batchId == batchId }
            loadError = if (envelope == null) "Booking not found." else null
        } catch (t: Throwable) {
            loadError = t.message ?: "Could not load booking."
        }
    }

    LaunchedEffect(batchId, kinfolkId) { reload() }

    Column(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(KinfolkSpacing.s),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", tint = KinfolkBrand.Navy)
            }
            Spacer(Modifier.width(KinfolkSpacing.xs))
            Text("Booking", style = type.heritageTitle)
        }

        val e = envelope
        when {
            loadError != null -> Text(
                loadError ?: "",
                style = type.sansBody,
                color = KinfolkBrand.SnuggleCoral,
                modifier = Modifier.padding(KinfolkSpacing.l),
            )
            e == null -> Box(
                modifier = Modifier.fillMaxWidth().padding(KinfolkSpacing.l),
                contentAlignment = Alignment.Center,
            ) {
                CircularProgressIndicator(color = KinfolkBrand.KinfolkOrange)
            }
            else -> EnvelopeBody(
                envelope = e,
                onOpenKinCare = { visitId -> onOpenKinCare(visitId, e.batchId) },
            )
        }
        Spacer(Modifier.height(KinfolkSpacing.l))
    }
}

@Composable
private fun EnvelopeBody(
    envelope: BookingEnvelope,
    onOpenKinCare: (String) -> Unit,
) {
    val type = LocalKinfolkTypography.current
    Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l),
        verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.m),
    ) {
        // Rollup header
        GlassCard(
            modifier = Modifier.fillMaxWidth(),
            contentPadding = PaddingValues(KinfolkSpacing.l),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
                Text(envelope.serviceName ?: "Booking", style = type.heritageTitle)
                Text(visitCountLabel(envelope.visitCount), style = type.sansLabel)
                ReviewRow("Pattern", patternLabel(envelope.pattern))
                ReviewRow("Status", envelopeStatusLabel(envelope.envelopeStatus))
                ReviewRow(
                    "Kin",
                    envelope.kinNames.takeIf { it.isNotEmpty() }?.joinToString(", ") ?: "TBD",
                )
            }
        }

        // Envelope-level note
        if (!envelope.notes.isNullOrBlank()) {
            GlassCard(
                modifier = Modifier.fillMaxWidth(),
                contentPadding = PaddingValues(KinfolkSpacing.l),
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.xs)) {
                    Text("On File", style = type.sansLabel)
                    Text(envelope.notes!!, style = type.sansBody)
                }
            }
        }

        Text("Visits", style = type.heritageSection)
        envelope.kinCares.forEach { kc ->
            KinCareRow(kc, onClick = { onOpenKinCare(kc.id) })
        }
    }
}

@Composable
private fun KinCareRow(kc: Booking, onClick: () -> Unit) {
    val type = LocalKinfolkTypography.current
    GlassCard(
        modifier = Modifier.fillMaxWidth().clickable { onClick() },
        contentPadding = PaddingValues(KinfolkSpacing.l),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(kc.title ?: kc.serviceType ?: "Visit", style = type.heritageTitle)
            Text(relativeTime(kc.startTimeMs), style = type.sansLabel)
            val parts = listOfNotNull(
                kc.auntieDisplayName,
                kc.kinNames.takeIf { it.isNotEmpty() }?.joinToString(", "),
            )
            if (parts.isNotEmpty()) {
                Text(parts.joinToString(" / "), style = type.sansMeta)
            }
        }
    }
}

private fun visitCountLabel(count: Int): String =
    if (count == 1) "1 visit" else "$count visits"

private fun patternLabel(pattern: String?): String = when (pattern) {
    "weekly" -> "Repeating Schedule"
    "individual" -> "Individual Dates"
    else -> pattern ?: "TBD"
}

private fun envelopeStatusLabel(status: EnvelopeStatus): String = when (status) {
    EnvelopeStatus.Requested -> "Requested"
    EnvelopeStatus.PartiallyConfirmed -> "Partially confirmed"
    EnvelopeStatus.Confirmed -> "Confirmed"
    EnvelopeStatus.InProgress -> "In progress"
    EnvelopeStatus.Completed -> "Completed"
    EnvelopeStatus.Cancelled -> "Cancelled"
}
