package com.tribetails.auntieos.ui.calls

import com.composables.icons.lucide.*
import com.composables.icons.lucide.Lucide
import android.Manifest
import android.content.Context
import android.net.Uri
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.data.model.CallEvent
import com.tribetails.auntieos.data.model.MessageEvent
import com.tribetails.auntieos.data.model.VoicemailEvent
import com.tribetails.auntieos.ui.components.*
import com.tribetails.auntieos.ui.components.AuntiePullRefresh
import com.tribetails.auntieos.ui.theme.*
import com.tribetails.auntieos.ui.theme.AuntieTheme
import com.tribetails.auntieos.voice.AudioRoute
import com.tribetails.auntieos.voice.CallInviteManager.VoiceCallState
import java.text.SimpleDateFormat
import java.util.*

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun CallsScreen(
    viewModel: CallsViewModel,
    onGenerateFollowUp: (String?, String) -> Unit
) {
    val state    by viewModel.uiState.collectAsState()
    val jumpToVm by viewModel.jumpToVoicemails.collectAsState()
    val context  = LocalContext.current

    var selectedTab by remember { mutableIntStateOf(0) }
    var showAddKinfolkDialog by remember { mutableStateOf<CallEvent?>(null) }

    val micPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) viewModel.answerCall(context)
    }

    LaunchedEffect(jumpToVm) {
        if (jumpToVm) {
            selectedTab = 1
            viewModel.consumeVoicemailJump()
        }
    }

    val voicemailBadge = if (state.voicemails.isNotEmpty()) " (${state.voicemails.size})" else ""

    AuntieScreenScaffold(title = "Calls") {
    AuntiePullRefresh(
        isRefreshing = state.isRefreshing,
        onRefresh = { viewModel.refresh() },
    ) {
        Column(
            modifier = Modifier.fillMaxSize()
        ) {
            AuntieTabRow(
                selectedIndex = selectedTab,
                tabs = listOf("Screening", "Voicemails$voicemailBadge", "Messages"),
                onSelect = { selectedTab = it }
            )

            when (selectedTab) {
                0 -> ScreeningTab(state, viewModel, context, micPermissionLauncher, onAddKinfolk = { showAddKinfolkDialog = it }, onGenerateFollowUp = onGenerateFollowUp)
                1 -> VoicemailsTab(state.voicemails, context, onGenerateFollowUp = onGenerateFollowUp)
                2 -> MessagesTab(state.messages)
            }
        }
    }
    }

    if (showAddKinfolkDialog != null) {
        AddKinfolkDialog(
            onDismiss = { showAddKinfolkDialog = null },
            onConfirm = { name ->
                showAddKinfolkDialog?.let { viewModel.createKinfolkFromCall(it, name) }
                showAddKinfolkDialog = null
            }
        )
    }
}

@Composable
fun AddKinfolkDialog(onDismiss: () -> Unit, onConfirm: (String) -> Unit) {
    var name by remember { mutableStateOf("") }
    AuntieModal(
        onDismissRequest = onDismiss,
        title = "New Kinfolk Profile",
        confirmButton = {
            PrimaryButton(
                label = "Create",
                onClick = { if (name.isNotBlank()) onConfirm(name) },
                enabled = name.isNotBlank()
            )
        },
        dismissButton = {
            AuntieTextBtn(onClick = onDismiss) {
                Text("Cancel")
            }
        }
    ) {
        Column {
            Text("Enter the name for this new client profile.")
            Spacer(Modifier.height(8.dp))
            AuntieField(
                value = name,
                onValueChange = { name = it },
                label = "Display Name",
                singleLine = true
            )
        }
    }
}

// ── Screening tab ─────────────────────────────────────────────────────────────

@Composable
private fun ScreeningTab(
    state: CallsUiState,
    viewModel: CallsViewModel,
    context: Context,
    micPermissionLauncher: androidx.activity.result.ActivityResultLauncher<String>,
    onAddKinfolk: (CallEvent) -> Unit,
    onGenerateFollowUp: (String?, String) -> Unit
) {
    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
        contentPadding = PaddingValues(vertical = 16.dp)
    ) {
        when (state.voiceCallState) {
            is VoiceCallState.Connected -> {
                item {
                    val currentRoute by viewModel.currentRoute.collectAsState()
                    val audioRouteError by viewModel.audioRouteError.collectAsState()
                    val availableRoutes = remember(currentRoute) { viewModel.availableRoutes(context) }
                    ConnectedCallBanner(
                        activeCall          = state.activeCall,
                        isMuted             = state.isMuted,
                        currentRoute        = currentRoute,
                        availableRoutes     = availableRoutes,
                        audioRouteError     = audioRouteError,
                        onToggleMute        = { viewModel.toggleMute() },
                        onSelectRoute       = { route -> viewModel.setRoute(context, route) },
                        onDismissAudioError = { viewModel.clearAudioRouteError() },
                        onHangUp            = { viewModel.hangUp() }
                    )
                }
            }
            is VoiceCallState.Ringing -> {
                state.activeCall?.let { call ->
                    item {
                        RingingCallBanner(
                            call     = call,
                            isActing = state.isActing,
                            onAnswer = {
                                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                                    micPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                                } else {
                                    viewModel.answerCall(context)
                                }
                            },
                            onSendToVoicemail = { viewModel.sendToVoicemail(call.callSid) }
                        )
                    }
                }
            }
            else -> {
                state.activeCall?.let { call ->
                    if (state.voiceCallState == VoiceCallState.Idle) {
                        item {
                            RingingCallBanner(
                                call     = call,
                                isActing = state.isActing,
                                onAnswer = {
                                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                                        micPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                                    } else {
                                        viewModel.answerCall(context)
                                    }
                                },
                                onSendToVoicemail = { viewModel.sendToVoicemail(call.callSid) }
                            )
                        }
                    }
                }
            }
        }

        state.actionResult?.let { msg ->
            item {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(8.dp))
                        .background(AuntieTheme.colors.success.copy(alpha = 0.12f))
                        .padding(14.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(msg, color = AuntieTheme.colors.success, style = AuntieTheme.typography.bodySmall)
                    AuntieTextBtn(
                        onClick = viewModel::clearActionResult,
                        contentColor = AuntieTheme.colors.success
                    ) {
                        Text("Dismiss")
                    }
                }
            }
        }

        if (state.events.isEmpty()) {
            item {
                Box(
                    modifier = Modifier.fillMaxWidth().padding(vertical = 40.dp),
                    contentAlignment = Alignment.Center
                ) {
                    Text("No call events yet.", style = AuntieTheme.typography.bodySmall)
                }
            }
        } else {
            item { Text("RECENT CALLS", style = AuntieTheme.typography.labelSmall) }
            items(state.events) { event -> CallEventRow(event, onAddKinfolk, onGenerateFollowUp) }
        }

        item { Spacer(Modifier.height(80.dp)) }
    }
}

// ── Ringing banner ──────────────────────────────────────────────────────────

@Composable
private fun RingingCallBanner(
    call: CallEvent,
    isActing: Boolean,
    onAnswer: () -> Unit,
    onSendToVoicemail: () -> Unit
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(AuntieTheme.colors.surface)
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
            modifier = Modifier.fillMaxWidth()
        ) {
            Text("INCOMING CALL", style = AuntieTheme.typography.labelSmall, color = AuntieTheme.colors.kinfolkOrange)
            Box(
                modifier = Modifier
                    .clip(RoundedCornerShape(4.dp))
                    .background(AuntieTheme.colors.kinfolkOrange.copy(alpha = 0.15f))
                    .padding(horizontal = 8.dp, vertical = 3.dp)
            ) {
                Text("RINGING", style = AuntieTheme.typography.labelSmall, color = AuntieTheme.colors.kinfolkOrange)
            }
        }

        Text(
            call.kinfolkName ?: call.callerNumber,
            style = AuntieTheme.typography.headlineMedium,
            fontWeight = FontWeight.Bold
        )
        if (call.kinfolkName != null) {
            Text(call.callerNumber, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textDim)
        }

        if (call.transcript.isNotBlank()) {
            Text(
                call.transcript,
                style    = AuntieTheme.typography.bodyMedium,
                color    = AuntieTheme.colors.textDim,
                maxLines = 4,
                overflow = TextOverflow.Ellipsis
            )
        }

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Box(
                modifier = Modifier
                    .weight(1f)
                    .height(40.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .background(if (!isActing) AuntieTheme.colors.success else AuntieTheme.colors.success.copy(alpha = 0.5f))
                    .clickable(enabled = !isActing, onClick = onAnswer)
                    .padding(horizontal = 18.dp),
                contentAlignment = Alignment.Center
            ) {
                Text("Answer", fontWeight = FontWeight.Bold, color = Color.White, style = AuntieTheme.typography.labelLarge)
            }

            Box(
                modifier = Modifier
                    .weight(1f)
                    .height(40.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .background(if (!isActing) AuntieTheme.colors.error else AuntieTheme.colors.error.copy(alpha = 0.5f))
                    .clickable(enabled = !isActing, onClick = onSendToVoicemail)
                    .padding(horizontal = 18.dp),
                contentAlignment = Alignment.Center
            ) {
                if (isActing) {
                    AuntieSpinner(modifier = Modifier.size(16.dp), color = Color.White, strokeWidth = 2.dp)
                } else {
                    Text("Voicemail", fontWeight = FontWeight.Bold, color = Color.White, style = AuntieTheme.typography.labelLarge)
                }
            }
        }
    }
}

// ── Connected banner ──────────────────────────────────────────────────────────

@Composable
private fun ConnectedCallBanner(
    activeCall: CallEvent?,
    isMuted: Boolean,
    currentRoute: AudioRoute,
    availableRoutes: Set<AudioRoute>,
    audioRouteError: String?,
    onToggleMute: () -> Unit,
    onSelectRoute: (AudioRoute) -> Unit,
    onDismissAudioError: () -> Unit,
    onHangUp: () -> Unit
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(AuntieTheme.colors.surface)
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
            modifier = Modifier.fillMaxWidth()
        ) {
            Text("CONNECTED", style = AuntieTheme.typography.labelSmall, color = AuntieTheme.colors.success)
            Box(
                modifier = Modifier
                    .clip(RoundedCornerShape(4.dp))
                    .background(AuntieTheme.colors.success.copy(alpha = 0.15f))
                    .padding(horizontal = 8.dp, vertical = 3.dp)
            ) {
                Text("LIVE", style = AuntieTheme.typography.labelSmall, color = AuntieTheme.colors.success)
            }
        }

        Text(
            activeCall?.kinfolkName ?: activeCall?.callerNumber ?: "Unknown",
            style      = AuntieTheme.typography.headlineMedium,
            fontWeight = FontWeight.Bold
        )

        // Mute toggle - full-width row of its own.
        val muteColor = if (isMuted) AuntieTheme.colors.error else AuntieTheme.colors.textPrimary
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(40.dp)
                .clip(RoundedCornerShape(8.dp))
                .background(AuntieTheme.colors.surfaceGlass)
                .border(1.dp, AuntieTheme.colors.border, RoundedCornerShape(8.dp))
                .clickable(onClick = onToggleMute)
                .padding(horizontal = 12.dp),
            contentAlignment = Alignment.Center
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp)
            ) {
                Icon(
                    imageVector = if (isMuted) Lucide.MicOff else Lucide.Mic,
                    contentDescription = if (isMuted) "Unmute" else "Mute",
                    modifier = Modifier.size(18.dp),
                    tint = muteColor
                )
                Text(if (isMuted) "Unmute" else "Mute", style = AuntieTheme.typography.labelLarge, color = muteColor)
            }
        }

        // 3-cell audio route toggle replaces the old binary Speaker/Earpiece box.
        AuntieAudioRouteToggle(
            current   = currentRoute,
            available = availableRoutes,
            onSelect  = onSelectRoute,
        )

        // Fail-loud surface for routing failures.
        StatusToast(
            visible   = audioRouteError != null,
            message   = audioRouteError ?: "",
            kind      = ToastKind.Error,
            onDismiss = onDismissAudioError,
        )

        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(40.dp)
                .clip(RoundedCornerShape(8.dp))
                .background(AuntieTheme.colors.error)
                .clickable(onClick = onHangUp)
                .padding(horizontal = 18.dp),
            contentAlignment = Alignment.Center
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                Icon(Lucide.PhoneOff, contentDescription = "Hang up", modifier = Modifier.size(18.dp), tint = Color.White)
                Text("Hang Up", fontWeight = FontWeight.Bold, color = Color.White, style = AuntieTheme.typography.labelLarge)
            }
        }
    }
}

// ── Call history row ──────────────────────────────────────────────────────────

@Composable
private fun CallEventRow(event: CallEvent, onAddKinfolk: (CallEvent) -> Unit, onGenerateFollowUp: (String?, String) -> Unit) {
    val context = LocalContext.current
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(AuntieTheme.colors.surface)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp)
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(event.kinfolkName ?: event.callerNumber, style = AuntieTheme.typography.titleMedium)
                if (event.kinfolkName != null) {
                    Text(event.callerNumber, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textDim)
                }
                if (event.transcript.isNotBlank()) {
                    Text(
                        event.transcript,
                        style    = AuntieTheme.typography.bodySmall,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis
                    )
                }
                Text(formatTimestamp(event.timestamp), style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textDim)
            }
            Spacer(Modifier.width(12.dp))
            ActionPill(event.actionTaken)
        }

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column {
                if (event.recordingUrl.isNotBlank()) {
                    AuntieTextBtn(
                        onClick = { openInBrowser(context, event.recordingUrl) },
                        modifier = Modifier.padding(0.dp)
                    ) {
                        Text("Play call recording", style = AuntieTheme.typography.bodySmall)
                    }
                }
                if (event.transcript.isNotBlank()) {
                    AuntieTextBtn(
                        onClick = { onGenerateFollowUp(event.kinfolkId, event.transcript) },
                        modifier = Modifier.padding(0.dp)
                    ) {
                        Text("Generate follow-up copy", style = AuntieTheme.typography.bodySmall)
                    }
                }
            }

            if (event.kinfolkId == null) {
                AuntieTextBtn(
                    onClick = { onAddKinfolk(event) },
                    modifier = Modifier.padding(0.dp)
                ) {
                    Icon(Lucide.UserPlus, contentDescription = null, modifier = Modifier.size(16.dp))
                    Spacer(Modifier.width(4.dp))
                    Text("Add to Kinfolk", style = AuntieTheme.typography.bodySmall)
                }
            }
        }
    }
}

@Composable
private fun ActionPill(action: String) {
    val (label, color) = when (action) {
        "answered" -> "Answered" to AuntieTheme.colors.success
        "rejected" -> "Voicemail" to AuntieTheme.colors.error
        else       -> "No response" to AuntieTheme.colors.textDim
    }
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(4.dp))
            .background(color.copy(alpha = 0.15f))
            .padding(horizontal = 8.dp, vertical = 3.dp)
    ) {
        Text(label, style = AuntieTheme.typography.labelSmall, color = color)
    }
}

// ── Voicemails tab ────────────────────────────────────────────────────────────

@Composable
private fun VoicemailsTab(voicemails: List<VoicemailEvent>, context: Context, onGenerateFollowUp: (String?, String) -> Unit) {
    if (voicemails.isEmpty()) {
        Box(
            modifier = Modifier.fillMaxSize().padding(vertical = 60.dp),
            contentAlignment = Alignment.Center
        ) {
            Text("No voicemails yet.", style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textDim)
        }
        return
    }

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
        contentPadding = PaddingValues(vertical = 16.dp)
    ) {
        items(voicemails) { vm ->
            VoicemailRow(vm, onGenerateFollowUp = onGenerateFollowUp) { openInBrowser(context, vm.playUrl) }
        }
        item { Spacer(Modifier.height(80.dp)) }
    }
}

@Composable
private fun VoicemailRow(vm: VoicemailEvent, onGenerateFollowUp: (String?, String) -> Unit, onPlay: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(AuntieTheme.colors.surface)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(vm.kinfolkName ?: vm.callerNumber, style = AuntieTheme.typography.titleMedium)
            Text(formatTimestamp(vm.timestamp), style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textDim)
        }
        if (vm.kinfolkName != null) {
            Text(vm.callerNumber, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textDim)
        }
        Text(
            vm.transcript,
            style    = AuntieTheme.typography.bodySmall,
            color    = AuntieTheme.colors.textDim,
            maxLines = 3,
            overflow = TextOverflow.Ellipsis
        )
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            AuntieTextBtn(
                onClick = { onGenerateFollowUp(vm.kinfolkId, vm.transcript) },
                modifier = Modifier.padding(0.dp)
            ) {
                Text("Generate follow-up copy", style = AuntieTheme.typography.bodySmall)
            }
            if (vm.playUrl.isNotBlank()) {
                AuntieTextBtn(
                    onClick = onPlay,
                    modifier = Modifier.padding(0.dp)
                ) {
                    Text("Play recording", style = AuntieTheme.typography.bodySmall)
                }
            }
        }
    }
}

// ── Messages tab ──────────────────────────────────────────────────────────────

@Composable
private fun MessagesTab(messages: List<MessageEvent>) {
    if (messages.isEmpty()) {
        Box(
            modifier = Modifier.fillMaxSize().padding(vertical = 60.dp),
            contentAlignment = Alignment.Center
        ) {
            Text("No messages yet.", style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textDim)
        }
        return
    }

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
        contentPadding = PaddingValues(vertical = 16.dp)
    ) {
        items(messages.sortedByDescending { it.timestamp }) { message ->
            MessageRow(message)
        }
        item { Spacer(Modifier.height(80.dp)) }
    }
}

@Composable
private fun MessageRow(message: MessageEvent) {
    val isOutbound = message.direction == "outbound"
    val backgroundColor = if (isOutbound) AuntieTheme.colors.kinfolkOrange.copy(alpha = 0.1f) else AuntieTheme.colors.surface
    val borderColor = if (isOutbound) AuntieTheme.colors.kinfolkOrange.copy(alpha = 0.3f) else AuntieTheme.colors.border

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(backgroundColor)
            .border(0.5.dp, borderColor, RoundedCornerShape(8.dp))
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column {
                Text(
                    message.kinfolkName ?: message.senderNumber,
                    style = AuntieTheme.typography.titleMedium
                )
                if (message.kinfolkName != null) {
                    Text(
                        message.senderNumber,
                        style = AuntieTheme.typography.bodySmall,
                        color = AuntieTheme.colors.textDim
                    )
                }
            }
            Column(horizontalAlignment = Alignment.End) {
                Text(
                    formatTimestamp(message.timestamp),
                    style = AuntieTheme.typography.bodySmall,
                    color = AuntieTheme.colors.textDim
                )
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(4.dp))
                        .background(if (isOutbound) AuntieTheme.colors.kinfolkOrange.copy(alpha = 0.15f) else AuntieTheme.colors.surface2)
                        .padding(horizontal = 6.dp, vertical = 2.dp)
                ) {
                    Text(
                        if (isOutbound) "SENT" else "RECEIVED",
                        style = AuntieTheme.typography.labelSmall,
                        color = if (isOutbound) AuntieTheme.colors.kinfolkOrange else AuntieTheme.colors.textDim
                    )
                }
            }
        }

        Text(
            message.body,
            style = AuntieTheme.typography.bodyMedium,
            color = AuntieTheme.colors.textPrimary
        )
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

private fun openInBrowser(context: Context, url: String) {
    if (url.isBlank()) return
    CustomTabsIntent.Builder().build().launchUrl(context, Uri.parse(url))
}

private fun formatTimestamp(millis: Long): String =
    SimpleDateFormat("MMM d, h:mm a", Locale.US).format(Date(millis))
