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
import com.tribetails.auntieos.web.ui.components.ReadStatusBanner
import com.tribetails.auntieos.web.ui.components.rememberLiveRead
import kotlinx.coroutines.launch
import kotlinx.datetime.TimeZone
import kotlin.time.Clock
import kotlin.time.ExperimentalTime


/**
 * Admin-direct "schedule a visit" dialog. Wires the Stage-1 createKinCareSession
 * callable (§A.9): unlike the Bookings create flow (which files a request needing
 * approval), this puts a SCHEDULED visit straight on the calendar. Fail-loud on any
 * write error; never fabricates a kinfolk/service.
 *
 * #1574, operator ruling 2026-11-05: a past-dated visit is allowed only as
 * already Completed, never Scheduled. A window that has ended turns the button
 * into "Record completed visit" and sends `recordAsCompleted`; one under way can
 * be neither and says so. Same split as the web dialog and the server.
 */
@OptIn(ExperimentalTime::class)
@Composable
fun NewVisitDialog(
    client: FirestoreClient,
    localZone: TimeZone,
    onDismiss: () -> Unit,
    onCreated: () -> Unit,
    /** Now, in epoch ms. A parameter so a test can stand at a known instant. */
    nowMs: () -> Long = { Clock.System.now().toEpochMilliseconds() },
) {
    val c = AuntieTheme.colors
    val scope = rememberReportingScope()

    // #898: a stream, not collectAsState directly, so a failed read (first load or a
    // later dropped poll) shows a visible error instead of an empty "no kinfolk" hint.
    val kinfolkRead = rememberLiveRead { client.kinfolkStream() }
    val settingsState by remember { client.businessSettingsStream() }.collectAsState(initial = FirestoreResult.Loading)

    val kinfolk = kinfolkRead.data.orEmpty()
        .sortedBy { it.displayName.lowercase() }
    // #1703: KinCare types come from Business-Settings serviceRates and nowhere
    // else, so every visit made here can be priced at invoice time.
    val serviceTypes = rateCardServiceTypes((settingsState as? FirestoreResult.Data)?.value?.serviceRates)

    var selectedKinfolk by remember { mutableStateOf<Kinfolk?>(null) }
    var serviceType by remember { mutableStateOf("") }
    var date by remember { mutableStateOf("") }
    var time by remember { mutableStateOf("") }
    var durationText by remember { mutableStateOf("30") }
    var notes by remember { mutableStateOf("") }
    var creating by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    val durationMinutes = durationText.toIntOrNull() ?: 0
    // #1574: read on every recomposition, so the button changes the moment the
    // typed window crosses into the past. Null while the date or time is incomplete.
    val draftTiming = buildRescheduleTimes(date, time, durationMinutes, localZone)
        ?.let { timingOf(it, localZone, nowMs()) }
    val canCreate = selectedKinfolk != null && serviceType in serviceTypes &&
        date.length == 10 && time.length == 5 && durationMinutes > 0 &&
        draftTiming != VisitWindowTiming.UNDERWAY

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
                        ReadStatusBanner(kinfolkRead, "kinfolk")
                        when {
                            kinfolkRead.snapshot.loading -> Text("Loading kinfolk...", style = AuntieTheme.typography.bodySmall, color = c.textDim)
                            kinfolkRead.snapshot.failed -> Unit // ReadStatusBanner above already says why
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
                        when {
                            settingsState is FirestoreResult.Loading ->
                                Text("Loading KinCare types...", style = AuntieTheme.typography.bodySmall, color = c.textDim)
                            settingsState is FirestoreResult.Error ->
                                Text(
                                    "Couldn't load KinCare types: ${(settingsState as FirestoreResult.Error).message}",
                                    style = AuntieTheme.typography.bodySmall,
                                    color = c.error,
                                )
                            serviceTypes.isEmpty() ->
                                Text(NO_KINCARE_TYPES_MESSAGE, style = AuntieTheme.typography.bodySmall, color = c.error)
                            else -> AuntieSelectField(
                                label = "Service *",
                                options = serviceTypes,
                                selected = serviceType,
                                onSelect = { serviceType = it },
                                modifier = Modifier.fillMaxWidth(),
                            )
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            BottomBorderField(date, { date = it }, label = "Date (YYYY-MM-DD)", modifier = Modifier.weight(1f))
                            BottomBorderField(time, { time = it }, label = "Time (HH:MM)", modifier = Modifier.weight(1f))
                        }
                        BottomBorderField(durationText, { durationText = it }, label = "Duration (minutes)", keyboardType = KeyboardType.Number, modifier = Modifier.fillMaxWidth())
                        MultilineField(notes, { notes = it }, label = "Notes", minLines = 2, modifier = Modifier.fillMaxWidth())
                    }
                }

                when (draftTiming) {
                    VisitWindowTiming.ENDED -> AuntieBanner(tone = AuntieBannerTone.Info, title = "Already happened") {
                        Text(RECORD_COMPLETED_HINT, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                    }
                    VisitWindowTiming.UNDERWAY ->
                        Text(VISIT_UNDERWAY_MESSAGE, style = AuntieTheme.typography.bodySmall, color = c.error)
                    else -> Unit
                }

                error?.let { err ->
                    AuntieBanner(tone = AuntieBannerTone.Error, title = "Couldn't schedule the visit") {
                        Text(err, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                    }
                }

                PrimaryButton(
                    label = when {
                        draftTiming == VisitWindowTiming.ENDED -> if (creating) "Recording" else "Record completed visit"
                        creating -> "Scheduling"
                        else -> "Schedule visit"
                    },
                    enabled = canCreate && !creating,
                    onClick = {
                        val kf = selectedKinfolk
                        val times = buildRescheduleTimes(date, time, durationMinutes, localZone)
                        val sendTiming = times?.let { timingOf(it, localZone, nowMs()) }
                        if (kf == null || times == null) {
                            error = "Pick a kinfolk and enter a valid date (YYYY-MM-DD), time (HH:MM), and duration."
                        } else if (sendTiming == VisitWindowTiming.UNDERWAY) {
                            error = VISIT_UNDERWAY_MESSAGE
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
                                    recordAsCompleted = sendTiming == VisitWindowTiming.ENDED,
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
