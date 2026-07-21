package com.tribetails.auntieos.ui.location

import com.composables.icons.lucide.*
import com.composables.icons.lucide.Lucide
import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.viewmodel.compose.viewModel
import android.util.Log
import com.mapbox.common.Cancelable
import com.mapbox.maps.MapView
import com.tribetails.auntieos.AuntieOSApp
import com.tribetails.auntieos.config.MapboxConfig
import com.tribetails.auntieos.data.admin.AuditLog
import com.tribetails.auntieos.data.model.LocationPoint
import com.tribetails.auntieos.data.model.MediaEntityType
import com.tribetails.auntieos.ui.components.*
import com.tribetails.auntieos.ui.media.MediaPickerDialog
import com.tribetails.auntieos.ui.media.MediaUploadViewModel
import com.tribetails.auntieos.ui.theme.*
import com.tribetails.auntieos.ui.theme.AuntieTheme
import kotlinx.coroutines.launch

@Composable
fun LiveTrackingScreen(
    sessionId: String,
    kinfolkId: String,
    kinfolkName: String,
    homeLocation: LocationPoint?,
    viewModel: LocationTrackingViewModel = viewModel(),
    onBack: () -> Unit
) {
    val context = LocalContext.current
    val state by viewModel.uiState.collectAsState()
    val scope = rememberCoroutineScope()
    val mediaUploadViewModel: MediaUploadViewModel = viewModel()
    var showMediaPicker by remember { mutableStateOf(false) }
    var showAddNoteDialog by remember { mutableStateOf(false) }
    var noteText by remember(sessionId) { mutableStateOf("") }
    var noteSubmitting by remember { mutableStateOf(false) }
    var noteError by remember { mutableStateOf<String?>(null) }
    // Phase 3 GPS refactor: live polyline + ping count now read from the
    // kin_care_sessions/{sessionId}/breadcrumbs subcollection (per
    // [[bug-sprint-architecture-decisions]]). VisitRoute.routePoints array is
    // being dropped in Step 4c once RouteViewerScreen also migrates.
    val repository = com.tribetails.auntieos.AuntieOSApp.instance.repository
    val pointsResult by repository.observeBreadcrumbs(sessionId)
        .collectAsState(initial = Result.success(emptyList<com.tribetails.auntieos.data.model.LocationPoint>()))
    val livePoints = remember(pointsResult) { pointsResult.getOrDefault(emptyList()) }
    var showPermissionDialog by remember { mutableStateOf(false) }

    // Permission launcher
    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { permissions ->
        val fineLocationGranted = permissions[Manifest.permission.ACCESS_FINE_LOCATION] == true
        val backgroundLocationGranted = permissions[Manifest.permission.ACCESS_BACKGROUND_LOCATION] == true

        viewModel.setLocationPermissionGranted(fineLocationGranted)

        if (fineLocationGranted) {
            viewModel.startLocationTracking(context, sessionId, kinfolkId, homeLocation)
        }
    }

    // Check permissions on first load
    LaunchedEffect(Unit) {
        val hasPermissions = ContextCompat.checkSelfPermission(
            context, Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED

        viewModel.setLocationPermissionGranted(hasPermissions)

        if (hasPermissions) {
            viewModel.startLocationTracking(context, sessionId, kinfolkId, homeLocation)
        } else {
            showPermissionDialog = true
        }
    }

    AuntieScreenScaffold(
        title = "$kinfolkName - Live Tracking",
        onBack = {
            if (state.isTracking) {
                viewModel.stopLocationTracking(context)
            }
            onBack()
        },
        backgroundFullBleed = true,
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            // Tracking Status Card
            TrackingStatusCard(
                isTracking = state.isTracking,
                route = state.currentRoute,
                onStartTracking = {
                    viewModel.startLocationTracking(context, sessionId, kinfolkId, homeLocation)
                },
                onStopTracking = {
                    viewModel.stopLocationTracking(context)
                },
                onPauseTracking = {
                    viewModel.pauseLocationTracking(context)
                },
                onResumeTracking = {
                    viewModel.resumeLocationTracking(context)
                }
            )

            // Real-time Stats. Null-safe path closes a race vs LocationTrackingService.stopTracking()
            // which nulls _currentRoute between the gate read and the second read.
            state.currentRoute?.let { route ->
                LiveStatsCard(route, livePoints)
            }

            // Live Map View (Placeholder - implement with actual Mapbox view)
            LiveMapCard(
                route = state.currentRoute,
                points = livePoints,
                isTracking = state.isTracking
            )

            // Visit Actions
            VisitActionsCard(
                sessionId = sessionId,
                isTracking = state.isTracking,
                onTakePhoto = { showMediaPicker = true },
                onAddNote = { showAddNoteDialog = true }
            )
        }

        // Media picker: routes uploads to the visit-log media bucket so the
        // photo lands on this specific session's media gallery. Audit fires
        // after the picker reports success.
        if (showMediaPicker) {
            MediaPickerDialog(
                entityId        = sessionId,
                entityType      = MediaEntityType.VISIT_LOG,
                entityName      = "$kinfolkName Visit",
                onDismiss       = { showMediaPicker = false },
                onMediaUploaded = { ids ->
                    AuditLog.fire(
                        scope            = scope,
                        repository       = AuntieOSApp.instance.repository,
                        actionType       = "VISIT_PHOTO_ADDED",
                        description      = "Added ${ids.size} media file(s) to live visit",
                        targetId         = sessionId,
                        targetCollection = "kin_care_sessions",
                    )
                },
                viewModel       = mediaUploadViewModel,
            )
        }

        // Add note: timestamped prepend onto the session.notes admin field
        // via the repository's patchKinCareSession path so the note shows up
        // in admin & KinTale composer immediately. Errors surface fail-loud
        // into the dialog body.
        if (showAddNoteDialog) {
            AuntieModal(
                onDismissRequest = {
                    if (!noteSubmitting) {
                        showAddNoteDialog = false
                        noteText = ""
                        noteError = null
                    }
                },
                title = "Add Visit Note",
                confirmButton = {
                    AuntieTextBtn(
                        onClick = {
                            val typed = noteText.trim()
                            if (typed.isBlank() || noteSubmitting) return@AuntieTextBtn
                            noteSubmitting = true
                            noteError      = null
                            scope.launch {
                                val repo = AuntieOSApp.instance.repository
                                val current = repo.getKinCareSession(sessionId).getOrNull()
                                val merged  = buildVisitNoteAppendix(current?.notes.orEmpty(), typed)
                                repo.patchKinCareSession(
                                    sessionId,
                                    mapOf("notes" to merged, "updatedAt" to liveNowIso()),
                                ).onSuccess {
                                    AuditLog.fire(
                                        scope            = scope,
                                        repository       = repo,
                                        actionType       = "VISIT_NOTE_ADDED",
                                        description      = "Field note added during live visit",
                                        targetId         = sessionId,
                                        targetCollection = "kin_care_sessions",
                                    )
                                    noteText         = ""
                                    noteSubmitting   = false
                                    showAddNoteDialog = false
                                }.onFailure { t ->
                                    noteError      = t.message ?: "Couldn't save note"
                                    noteSubmitting = false
                                }
                            }
                        },
                    ) { Text(if (noteSubmitting) "SAVING…" else "SAVE") }
                },
                dismissButton = {
                    AuntieTextBtn(onClick = {
                        if (!noteSubmitting) {
                            showAddNoteDialog = false
                            noteText  = ""
                            noteError = null
                        }
                    }) { Text("CANCEL") }
                },
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(
                        text  = "Capture what you're seeing right now - visible to the office and used in the KinTale recap.",
                        style = AuntieTheme.typography.bodySmall,
                        color = AuntieTheme.colors.textDim,
                    )
                    AuntieField(
                        value         = noteText,
                        onValueChange = { noteText = it },
                        label         = "Note",
                        placeholder   = "What happened during the visit?",
                        singleLine    = false,
                        minLines      = 3,
                        maxLines      = 6,
                        modifier      = Modifier.fillMaxWidth(),
                    )
                    noteError?.let { err ->
                        Text(
                            text  = err,
                            style = AuntieTheme.typography.bodySmall,
                            color = AuntieTheme.colors.error,
                        )
                    }
                }
            }
        }

        // Error Snackbar
        state.error?.let { error ->
            LaunchedEffect(error) {
                // Show snackbar
                viewModel.clearError()
            }
        }
    }

    // Permission Request Dialog
    if (showPermissionDialog) {
        LocationPermissionDialog(
            onGrantPermissions = {
                showPermissionDialog = false
                permissionLauncher.launch(
                    arrayOf(
                        Manifest.permission.ACCESS_FINE_LOCATION,
                        Manifest.permission.ACCESS_COARSE_LOCATION,
                        Manifest.permission.ACCESS_BACKGROUND_LOCATION
                    )
                )
            },
            onDismiss = {
                showPermissionDialog = false
                onBack()
            }
        )
    }
}

@Composable
private fun TrackingStatusCard(
    isTracking: Boolean,
    route: com.tribetails.auntieos.data.model.VisitRoute?,
    onStartTracking: () -> Unit,
    onStopTracking: () -> Unit,
    onPauseTracking: () -> Unit,
    onResumeTracking: () -> Unit
) {
    AuntieCard {
        Column(
            modifier = Modifier.padding(16.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Box(
                        modifier = Modifier
                            .size(12.dp)
                            .clip(CircleShape)
                            .background(if (isTracking) AuntieTheme.colors.success else AuntieTheme.colors.textDim)
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(
                        if (isTracking) "TRACKING ACTIVE" else "TRACKING STOPPED",
                        style = AuntieTheme.typography.labelSmall,
                        color = if (isTracking) AuntieTheme.colors.success else AuntieTheme.colors.textDim,
                        fontWeight = FontWeight.Bold
                    )
                }

                Row {
                    if (isTracking) {
                        AuntieIconBtn(onClick = onPauseTracking) {
                            Icon(Lucide.Pause, contentDescription = "Pause", tint = AuntieTheme.colors.kinfolkOrange)
                        }
                        AuntieIconBtn(onClick = onStopTracking) {
                            Icon(Lucide.Square, contentDescription = "Stop", tint = AuntieTheme.colors.error)
                        }
                    } else {
                        AuntieIconBtn(onClick = onStartTracking) {
                            Icon(Lucide.Play, contentDescription = "Start", tint = AuntieTheme.colors.success)
                        }
                    }
                }
            }

            if (route != null) {
                Spacer(Modifier.height(12.dp))
                Text(
                    "Route started at ${formatTime(route.startTime)}",
                    style = AuntieTheme.typography.bodySmall,
                    color = AuntieTheme.colors.textDim
                )
            }
        }
    }
}

@Composable
private fun LiveStatsCard(route: com.tribetails.auntieos.data.model.VisitRoute, points: List<LocationPoint>) {
    AuntieCard {
        Column(
            modifier = Modifier.padding(16.dp)
        ) {
            Text(
                "LIVE STATS",
                style = AuntieTheme.typography.labelSmall,
                color = AuntieTheme.colors.kinfolkOrange
            )

            Spacer(Modifier.height(12.dp))

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceEvenly
            ) {
                LiveStatItem(
                    label = "Distance",
                    value = formatDistance(route.totalDistance),
                    icon = Lucide.Footprints
                )
                LiveStatItem(
                    label = "Duration",
                    value = formatDuration(System.currentTimeMillis() -
                        (points.firstOrNull()?.timestamp ?: System.currentTimeMillis())),
                    icon = Lucide.Timer
                )
                LiveStatItem(
                    label = "Points",
                    value = "${points.size}",
                    icon = Lucide.MapPin
                )
            }

            if (route.visitVerified) {
                Spacer(Modifier.height(8.dp))
                Row(
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Icon(
                        Lucide.House,
                        contentDescription = "At Home",
                        tint = AuntieTheme.colors.success,
                        modifier = Modifier.size(16.dp)
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(
                        "Currently at client's home",
                        style = AuntieTheme.typography.bodySmall,
                        color = AuntieTheme.colors.success
                    )
                }
            }
        }
    }
}

@Composable
private fun LiveStatItem(
    label: String,
    value: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector
) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Icon(
            icon,
            contentDescription = null,
            tint = AuntieTheme.colors.kinfolkOrange,
            modifier = Modifier.size(20.dp)
        )
        Spacer(Modifier.height(4.dp))
        Text(
            value,
            style = AuntieTheme.typography.titleSmall,
            fontWeight = FontWeight.Bold
        )
        Text(
            label,
            style = AuntieTheme.typography.labelSmall,
            color = AuntieTheme.colors.textDim
        )
    }
}

@Composable
private fun LiveMapCard(
    route: com.tribetails.auntieos.data.model.VisitRoute?,
    points: List<LocationPoint>,
    isTracking: Boolean
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    AuntieCard {
        Column {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(220.dp)
                    .background(AuntieTheme.colors.surface2),
                contentAlignment = Alignment.Center
            ) {
                if (points.isNotEmpty()) {
                    // Stable MapView across recompositions: created once, lifecycle wiring
                    // happens in DisposableEffect so observers are registered/removed
                    // exactly once (not on every recomposition).
                    val mapView = remember {
                        MapView(context).apply {
                            // v11 migration: use the mapboxMap property and loadStyle lambda.
                            mapboxMap.loadStyle(MapboxConfig.DEFAULT_STYLE)
                        }
                    }

                    // Register lifecycle observer + map-loading-error subscription ONCE.
                    // DisposableEffect re-keys only if mapView or lifecycleOwner identity
                    // changes, guaranteeing cleanup on dispose.
                    DisposableEffect(mapView, lifecycleOwner) {
                        // v11 migration: subscribeMapLoadingError replaces the removed
                        // OnMapLoadErrorListener. Fail-loud policy: log errors.
                        val errorCancelable: Cancelable =
                            mapView.mapboxMap.subscribeMapLoadingError { error ->
                                Log.e(
                                    "LiveTrackingScreen",
                                    "Mapbox load error (type=${error.type}, " +
                                        "sourceId=${error.sourceId}): ${error.message}"
                                )
                            }
                        val observer = LifecycleEventObserver { _, event ->
                            when (event) {
                                Lifecycle.Event.ON_START -> mapView.onStart()
                                Lifecycle.Event.ON_STOP -> mapView.onStop()
                                Lifecycle.Event.ON_DESTROY -> mapView.onDestroy()
                                else -> {}
                            }
                        }
                        lifecycleOwner.lifecycle.addObserver(observer)
                        onDispose {
                            errorCancelable.cancel()
                            lifecycleOwner.lifecycle.removeObserver(observer)
                            mapView.onDestroy()
                        }
                    }

                    AndroidView(
                        modifier = Modifier.fillMaxSize(),
                        factory = { mapView },
                        update = { mv ->
                            // Per-recomposition data binding only: redraw polyline as new
                            // pings arrive. No lifecycle wiring here.
                            mv.mapboxMap.getStyle { style ->
                                drawRoute(mv, points, style)
                                fitCameraToRoute(mv, points)
                            }
                        },
                    )
                } else {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Icon(
                            Lucide.Map,
                            contentDescription = null,
                            modifier = Modifier.size(48.dp),
                            tint = AuntieTheme.colors.textDim
                        )
                        Spacer(Modifier.height(8.dp))
                        Text(
                            if (isTracking) "Waiting for first GPS ping…" else "Start tracking to see route",
                            style = AuntieTheme.typography.bodySmall,
                            color = AuntieTheme.colors.textDim,
                        )
                    }
                }
            }
            if (points.isNotEmpty()) {
                Text(
                    "${points.size} pings",
                    style = AuntieTheme.typography.labelSmall,
                    color = AuntieTheme.colors.textDim,
                    modifier = Modifier.padding(8.dp),
                )
            }
        }
    }
}

@Composable
private fun VisitActionsCard(
    sessionId: String,
    isTracking: Boolean,
    onTakePhoto: () -> Unit,
    onAddNote: () -> Unit
) {
    AuntieCard {
        Column(
            modifier = Modifier.padding(16.dp)
        ) {
            Text(
                "VISIT ACTIONS",
                style = AuntieTheme.typography.labelSmall,
                color = AuntieTheme.colors.kinfolkOrange
            )

            Spacer(Modifier.height(12.dp))

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                PrimaryButton(
                    label = "Photo",
                    onClick = onTakePhoto,
                    modifier = Modifier.weight(1f),
                    enabled = isTracking,
                    leading = { Icon(Lucide.Camera, contentDescription = null, modifier = Modifier.size(18.dp)) }
                )

                GhostButton(
                    label = "Note",
                    onClick = onAddNote,
                    modifier = Modifier.weight(1f),
                    enabled = isTracking,
                    leading = { Icon(Lucide.StickyNote, contentDescription = null, modifier = Modifier.size(18.dp)) }
                )
            }
        }
    }
}

@Composable
private fun LocationPermissionDialog(
    onGrantPermissions: () -> Unit,
    onDismiss: () -> Unit
) {
    AuntieModal(
        onDismissRequest = onDismiss,
        title = "Location Access Required",
        confirmButton = {
            PrimaryButton(
                label = "Grant Permission",
                onClick = onGrantPermissions
            )
        },
        dismissButton = {
            AuntieTextBtn(onClick = onDismiss) {
                Text("Cancel")
            }
        }
    ) {
        Text("To track your route during visits and provide transparency to clients, we need access to your location. This enables:\n\n• Route recording during dog walks\n• Arrival/departure verification\n• Visit documentation for clients")
    }
}

// Utility functions
private fun formatDistance(meters: Double): String {
    return if (meters >= 1000) {
        String.format("%.1f km", meters / 1000.0)
    } else {
        String.format("%.0f m", meters)
    }
}

private fun formatDuration(milliseconds: Long): String {
    val minutes = milliseconds / 60000
    val hours = minutes / 60
    val remainingMinutes = minutes % 60

    return if (hours > 0) {
        "${hours}h ${remainingMinutes}m"
    } else {
        "${minutes}m"
    }
}

private fun formatTime(timestamp: String): String {
    return try {
        val instant = java.time.Instant.parse(timestamp)
        val formatter = java.text.SimpleDateFormat("HH:mm", java.util.Locale.getDefault())
        formatter.format(java.util.Date(instant.toEpochMilli()))
    } catch (e: Exception) {
        timestamp
    }
}

internal fun liveNowIso(): String =
    java.time.Instant.now().toString().substringBefore('.') + "Z"

/**
 * Pure helper: prepends a timestamped field note to an existing session.notes
 * string. Top-level + internal so the formatting can be locked under JVM
 * tests per [[compose-pure-helper-tdd]]. Empty input is a no-op (defensive -
 * the dialog gate already blocks blanks).
 *
 *  [2026-05-19T14:23:00Z] (field) {body}
 */
internal fun buildVisitNoteAppendix(existing: String, addition: String): String {
    val trimmedAdd = addition.trim()
    if (trimmedAdd.isBlank()) return existing
    val stamped = "[${liveNowIso()}] (field) $trimmedAdd"
    return if (existing.isBlank()) stamped else "$stamped\n$existing"
}
