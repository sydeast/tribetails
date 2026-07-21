package com.tribetails.auntieos.web.screens.schedule

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import com.tribetails.auntieos.web.observability.rememberReportingScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.Kinfolk
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.AuntieBanner
import com.tribetails.auntieos.web.ui.components.AuntieBannerTone
import com.tribetails.auntieos.web.ui.components.AuntieSelectField
import com.tribetails.auntieos.web.ui.components.BottomBorderField
import com.tribetails.auntieos.web.ui.components.DenPanel
import com.tribetails.auntieos.web.ui.components.GhostButton
import com.tribetails.auntieos.web.ui.components.MultilineField
import com.tribetails.auntieos.web.ui.components.PrimaryButton
import kotlinx.coroutines.launch
import kotlinx.datetime.TimeZone

private val FALLBACK_SERVICE_TYPES = listOf("Drop-In", "Dog Walking", "Pet Sitting", "Overnight", "Daycare", "Other")

/**
 * Admin-direct "schedule a visit" dialog. Wires the Stage-1 createKinCareSession
 * callable (§A.9): unlike the Bookings create flow (which files a request needing
 * approval), this puts a SCHEDULED visit straight on the calendar. Fail-loud on any
 * write error; never fabricates a kinfolk/service.
 */
@Composable
fun NewVisitDialog(
    client: FirestoreClient,
    localZone: TimeZone,
    onDismiss: () -> Unit,
    onCreated: () -> Unit,
) {
    val c = AuntieTheme.colors
    val scope = rememberReportingScope()

    val kinfolkState by remember { client.kinfolkStream() }.collectAsState(initial = FirestoreResult.Loading)
    val settingsState by remember { client.businessSettingsStream() }.collectAsState(initial = FirestoreResult.Loading)

    val kinfolk = (kinfolkState as? FirestoreResult.Data)?.value.orEmpty()
        .sortedBy { it.displayName.lowercase() }
    // KinCare types come from Business-Settings serviceRates (never hardcoded); fall
    // back to a small default list only when settings carry none yet.
    val serviceTypes = (settingsState as? FirestoreResult.Data)?.value?.serviceRates?.keys
        ?.toList()?.takeIf { it.isNotEmpty() } ?: FALLBACK_SERVICE_TYPES

    var selectedKinfolk by remember { mutableStateOf<Kinfolk?>(null) }
    var serviceType by remember { mutableStateOf("") }
    var date by remember { mutableStateOf("") }
    var time by remember { mutableStateOf("") }
    var durationText by remember { mutableStateOf("30") }
    var notes by remember { mutableStateOf("") }
    var creating by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    val durationMinutes = durationText.toIntOrNull() ?: 0
    val canCreate = selectedKinfolk != null && serviceType.isNotBlank() &&
        date.length == 10 && time.length == 5 && durationMinutes > 0

    Box(
        modifier = Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.45f)),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            modifier = Modifier
                .width(480.dp)
                .clip(RoundedCornerShape(18.dp))
                .background(c.background)
                .border(AuntieTheme.dims.borderHairline, c.border, RoundedCornerShape(18.dp))
                .padding(20.dp),
        ) {
            Column(
                modifier = Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.Top,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(
                            text = "Schedule a visit",
                            style = AuntieTheme.typography.mono.copy(letterSpacing = 1.6.sp, fontSize = 11.sp),
                            color = c.primary,
                        )
                        Spacer(Modifier.height(4.dp))
                        Text(
                            text = "New visit",
                            style = AuntieTheme.typography.headlineMedium,
                            color = c.textPrimary,
                        )
                    }
                    GhostButton(label = "Close", onClick = onDismiss)
                }

                DenPanel(title = "Details") {
                    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        when {
                            kinfolkState is FirestoreResult.Loading -> Text("Loading kinfolk...", style = AuntieTheme.typography.bodySmall, color = c.textDim)
                            kinfolk.isEmpty() -> Text("No kinfolk on file to schedule for.", style = AuntieTheme.typography.bodySmall, color = c.textDim)
                            else -> AuntieSelectField(
                                label = "Kinfolk *",
                                options = kinfolk,
                                selected = selectedKinfolk ?: kinfolk.first(),
                                onSelect = { selectedKinfolk = it },
                                optionLabel = { it.displayName.ifBlank { "Unnamed Kinfolk" } },
                                modifier = Modifier.fillMaxWidth(),
                            )
                        }
                        AuntieSelectField(
                            label = "Service *",
                            options = serviceTypes,
                            selected = serviceType,
                            onSelect = { serviceType = it },
                            modifier = Modifier.fillMaxWidth(),
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            BottomBorderField(date, { date = it }, label = "Date (YYYY-MM-DD)", modifier = Modifier.weight(1f))
                            BottomBorderField(time, { time = it }, label = "Time (HH:MM)", modifier = Modifier.weight(1f))
                        }
                        BottomBorderField(durationText, { durationText = it }, label = "Duration (minutes)", keyboardType = KeyboardType.Number, modifier = Modifier.fillMaxWidth())
                        MultilineField(notes, { notes = it }, label = "Notes", minLines = 2, modifier = Modifier.fillMaxWidth())
                    }
                }

                error?.let { err ->
                    AuntieBanner(tone = AuntieBannerTone.Error, title = "Couldn't schedule the visit") {
                        Text(err, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                    }
                }

                PrimaryButton(
                    label = if (creating) "Scheduling" else "Schedule visit",
                    enabled = canCreate && !creating,
                    onClick = {
                        val kf = selectedKinfolk
                        val times = buildRescheduleTimes(date, time, durationMinutes, localZone)
                        if (kf == null || times == null) {
                            error = "Pick a kinfolk and enter a valid date (YYYY-MM-DD), time (HH:MM), and duration."
                        } else {
                            scope.launch {
                                creating = true
                                error = null
                                val r = client.createKinCareSession(
                                    kinfolkId = kf._id,
                                    kinIds = emptyList(), // KinCare covers the household; no per-kin select
                                    serviceType = serviceType,
                                    startTime = times.first,
                                    endTime = times.second,
                                    serviceDurationMinutes = durationMinutes,
                                    notes = notes.trim(),
                                )
                                creating = false
                                when (r) {
                                    is WriteResult.Ok -> onCreated()
                                    is WriteResult.Err -> error = r.message
                                }
                            }
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
    }
}
