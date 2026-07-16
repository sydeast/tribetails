package com.tribetails.auntieos.web.screens.inbox

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import androidx.compose.ui.unit.dp
import com.composables.icons.lucide.ArrowDownLeft
import com.composables.icons.lucide.ArrowUpRight
import com.composables.icons.lucide.Images
import com.composables.icons.lucide.Inbox
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Mail
import com.composables.icons.lucide.MessageSquare
import com.composables.icons.lucide.Phone
import com.composables.icons.lucide.PhoneMissed
import com.composables.icons.lucide.Play
import com.composables.icons.lucide.Voicemail
import com.tribetails.auntieos.web.data.CallLog
import com.tribetails.auntieos.web.data.EmailMessage
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.NotificationEntry
import com.tribetails.auntieos.web.data.SmsMessage
import com.tribetails.auntieos.web.data.VoicemailLog
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.AuntieBanner
import com.tribetails.auntieos.web.ui.components.AuntieBannerTone
import com.tribetails.auntieos.web.ui.components.AuntieCheckbox
import com.tribetails.auntieos.web.ui.components.AuntieChip
import com.tribetails.auntieos.web.ui.components.AuntieChipTone
import com.tribetails.auntieos.web.ui.components.AuntieEmptyState
import com.tribetails.auntieos.web.ui.components.AuntieEntityRow
import com.tribetails.auntieos.web.ui.components.AuntieIconTile
import com.tribetails.auntieos.web.ui.components.AuntieStatusTone
import com.tribetails.auntieos.web.ui.components.BottomBorderField
import com.tribetails.auntieos.web.ui.components.DenPanel
import com.tribetails.auntieos.web.ui.components.MultilineField
import com.tribetails.auntieos.web.ui.components.DenScreenHeading
import com.tribetails.auntieos.web.ui.components.GhostButton
import com.tribetails.auntieos.web.ui.components.PrimaryButton
import com.tribetails.auntieos.web.ui.components.ScreenScaffold
import com.tribetails.auntieos.web.ui.components.ShimmerCard
import com.tribetails.auntieos.web.ui.components.StatusToast
import com.tribetails.auntieos.web.ui.components.ToastKind
import com.tribetails.auntieos.web.util.nowIso
import com.tribetails.auntieos.web.util.openUrl
import kotlinx.coroutines.launch

private enum class Channel(val label: String, val icon: ImageVector) {
    All       ("All",        Lucide.Inbox),
    Voicemail ("Voicemails", Lucide.Voicemail),
    Call      ("Calls",      Lucide.Phone),
    Sms       ("SMS",        Lucide.MessageSquare),
    Email     ("Emails",     Lucide.Mail),
}

private data class InboxEntry(
    val id: String,
    val channel: Channel,
    val timestamp: String,
    val kinfolkId: String?,
    val kinfolkName: String,
    val counterpart: String,
    val preview: String,
    val replyTargetPhone: String,
    val replyTargetEmail: String,
    val voicemailAudioUrl: String,
    val canReply: Boolean,
    val direction: String,    // inbound | outbound | "" (voicemail)
    val statusHint: String,   // missed | unread | ""
    val mediaCount: Int,
)

@Composable
fun InboxScreen() {
    val client = remember { FirestoreClient() }
    val scope = rememberCoroutineScope()
    val voicemails by remember { client.voicemailsStream() }.collectAsState(initial = FirestoreResult.Loading)
    val calls       by remember { client.callsStream() }.collectAsState(initial = FirestoreResult.Loading)
    val sms         by remember { client.smsStream() }.collectAsState(initial = FirestoreResult.Loading)
    val emails      by remember { client.emailsStream() }.collectAsState(initial = FirestoreResult.Loading)
    val notifications by remember { client.notificationsStream() }.collectAsState(initial = FirestoreResult.Loading)

    var filter by remember { mutableStateOf(Channel.All) }
    var toast by remember { mutableStateOf("") }
    var toastKind by remember { mutableStateOf(ToastKind.Info) }
    var toastVisible by remember { mutableStateOf(false) }
    var selectedEntryId by remember { mutableStateOf<String?>(null) }
    var replyBody by remember { mutableStateOf("") }
    var isSendingReply by remember { mutableStateOf(false) }

    // Bulk mark-read selection over the real `notifications` collection.
    val notifSelected = remember { mutableStateMapOf<String, Boolean>() }
    var markBusy by remember { mutableStateOf(false) }

    fun showToast(message: String, kind: ToastKind = ToastKind.Info) {
        toast = message
        toastKind = kind
        toastVisible = true
    }

    fun bulkMarkRead() {
        val ids = notifSelected.filterValues { it }.keys.toList()
        if (ids.isEmpty()) return
        markBusy = true
        scope.launch {
            when (val r = client.bulkMarkNotificationsRead(ids)) {
                is WriteResult.Err -> showToast("Couldn't mark read: ${r.message}", ToastKind.Error)
                is WriteResult.Ok  -> {
                    notifSelected.clear()
                    showToast("Marked ${r.value} read.", ToastKind.Success)
                }
            }
            markBusy = false
        }
    }

    ScreenScaffold {
        DenScreenHeading(
            kicker     = "The Den · Inbox",
            title      = "Inbox",
            // Operator-facing UI chrome (no kinfolk-facing copy).
            subtitle   = "Voicemails, calls, SMS, and emails, everywhere kinfolk reach out.",
        )
        Spacer(Modifier.height(20.dp))

        // Notifications: the real `notifications` collection with multi-select +
        // bulk "Mark read" via the bulkMarkNotificationsRead callable.
        NotificationsSection(
            state = notifications,
            selected = notifSelected,
            markBusy = markBusy,
            onToggle = { id ->
                if (notifSelected[id] == true) notifSelected.remove(id) else notifSelected[id] = true
            },
            onMarkRead = { bulkMarkRead() },
        )
        Spacer(Modifier.height(14.dp))

        // Stage 2 step 7: two-way kinfolk<->auntie message threads (Message Auntie).
        MessagesPanel(client = client)
        Spacer(Modifier.height(14.dp))

        DenPanel(
            title = "Channels",
            subtitle = "Voicemails, calls, SMS, and emails. Tap a row to reply, call, or play a voicemail.",
        ) {
            ChannelFilterRow(selected = filter, onSelect = { filter = it })

            StatusToast(
                visible   = toastVisible,
                message   = toast,
                kind      = toastKind,
                onDismiss = { toastVisible = false },
            )

            Spacer(Modifier.height(8.dp))

            // Aggregate the four streams. Show shimmer until all four have resolved
            // so the list doesn't reorder mid-load. Surface EVERY error loudly: a
            // single bad channel must not silently blank the others.
            val streams  = listOf(voicemails, calls, sms, emails)
            val anyLoad  = streams.any { it is FirestoreResult.Loading }
            val errors   = streams.filterIsInstance<FirestoreResult.Error>()

            if (errors.isNotEmpty()) {
                AuntieBanner(
                    tone = AuntieBannerTone.Error,
                    title = "Couldn't load every channel",
                    icon = Lucide.Inbox,
                    pillLabel = "${errors.size} FAILED",
                ) {
                    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                        errors.forEach { err ->
                            Text(
                                text = err.message,
                                style = AuntieTheme.typography.bodySmall,
                                color = AuntieTheme.colors.error,
                            )
                        }
                    }
                }
                Spacer(Modifier.height(12.dp))
            }

            when {
                // Still resolving (no errors yet): shimmer placeholders.
                anyLoad && errors.isEmpty() ->
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        repeat(4) { ShimmerCard(height = 80.dp) }
                    }

                else -> {
                    // Render whatever channels DID resolve. A failed channel is
                    // already surfaced in the error banner above; the rest still show.
                    val entries = buildList {
                        (voicemails as? FirestoreResult.Data)?.value?.forEach { add(it.toEntry()) }
                        (calls       as? FirestoreResult.Data)?.value?.forEach { add(it.toEntry()) }
                        (sms         as? FirestoreResult.Data)?.value?.forEach { add(it.toEntry()) }
                        (emails      as? FirestoreResult.Data)?.value?.forEach { add(it.toEntry()) }
                    }
                        .sortedByDescending { it.timestamp }
                        .filter { filter == Channel.All || it.channel == filter }

                    val selectedEntry = entries.firstOrNull { it.id == selectedEntryId }
                    if (selectedEntryId != null && selectedEntry == null) {
                        selectedEntryId = null
                        replyBody = ""
                    }

                    if (entries.isEmpty()) {
                        if (errors.isEmpty()) EmptyState(filter)
                    } else {
                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            entries.forEach { entry ->
                                val selected = selectedEntry?.id == entry.id
                                InboxRow(
                                    entry = entry,
                                    selected = selected,
                                    onClick = {
                                        if (selected) {
                                            selectedEntryId = null
                                            replyBody = ""
                                        } else {
                                            selectedEntryId = entry.id
                                            replyBody = ""
                                            // Auto-mark unread voicemails as read when opened.
                                            if (entry.channel == Channel.Voicemail && entry.statusHint == "unread") {
                                                scope.launch {
                                                    when (val r = client.markVoicemailRead(entry.id)) {
                                                        is WriteResult.Ok  -> Unit
                                                        is WriteResult.Err -> showToast(
                                                            "Couldn't mark voicemail read: ${r.message}",
                                                            ToastKind.Error,
                                                        )
                                                    }
                                                }
                                            }
                                        }
                                    },
                                )
                                if (selected) {
                                    ThreadActionsCard(
                                        entry = entry,
                                        replyBody = replyBody,
                                        sending = isSendingReply,
                                        onReplyBodyChange = { replyBody = it },
                                        onPlayVoicemail = {
                                            if (entry.voicemailAudioUrl.isBlank()) {
                                                showToast("No voicemail recording URL on this thread.", ToastKind.Error)
                                            } else {
                                                openUrl(entry.voicemailAudioUrl)
                                            }
                                        },
                                        onSendReply = {
                                            if (isSendingReply) return@ThreadActionsCard
                                            if (!entry.canReply || entry.replyTargetPhone.isBlank()) {
                                                showToast("This thread has no phone target for reply.", ToastKind.Error)
                                                return@ThreadActionsCard
                                            }
                                            val body = replyBody.trim()
                                            if (body.isBlank()) {
                                                showToast("Reply message can't be blank.", ToastKind.Error)
                                                return@ThreadActionsCard
                                            }
                                            isSendingReply = true
                                            scope.launch {
                                                try {
                                                    val sent = client.sendExternalMessage(
                                                        channel = "sms",
                                                        to = entry.replyTargetPhone,
                                                        subject = null,
                                                        body = body,
                                                        transactional = true,
                                                    )
                                                    val providerId = when (sent) {
                                                        is WriteResult.Ok -> sent.value.providerMessageId
                                                        is WriteResult.Err -> {
                                                            showToast("Reply failed: ${sent.message}", ToastKind.Error)
                                                            return@launch
                                                        }
                                                    }
                                                    if (entry.channel == Channel.Voicemail) {
                                                        when (val write = client.markVoicemailReplied(
                                                            voicemailId = entry.id,
                                                            repliedAtIso = nowIso(),
                                                            replyLogId = providerId,
                                                        )) {
                                                            is WriteResult.Ok -> Unit
                                                            is WriteResult.Err -> {
                                                                showToast(
                                                                    "Reply sent, but voicemail status update failed: ${write.message}",
                                                                    ToastKind.Error,
                                                                )
                                                                return@launch
                                                            }
                                                        }
                                                    }
                                                    replyBody = ""
                                                    showToast("Reply sent.", ToastKind.Success)
                                                } catch (t: Throwable) {
                                                    showToast("Reply failed: ${t.message ?: "unknown error"}", ToastKind.Error)
                                                } finally {
                                                    isSendingReply = false
                                                }
                                            }
                                        },
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/**
 * Stage 2 step 7 (Inbox conversations / Message Auntie 16.4): two-way message
 * threads between a kinfolk household and the auntie. Loads the thread list via
 * listConversations; opening a thread fetches its messages (getConversationThread,
 * which also clears the admin unread flag) and reveals a reply box wired to
 * replyToConversation. Fail-loud: load / send errors surface in a banner.
 */
@Composable
private fun MessagesPanel(client: FirestoreClient) {
    val c = AuntieTheme.colors
    val scope = rememberCoroutineScope()

    var conversations by remember { mutableStateOf<List<ConversationSummary>?>(null) }
    var listError by remember { mutableStateOf<String?>(null) }
    var selectedId by remember { mutableStateOf<String?>(null) }
    var thread by remember { mutableStateOf<List<ThreadMessage>>(emptyList()) }
    var threadLoading by remember { mutableStateOf(false) }
    var threadError by remember { mutableStateOf<String?>(null) }
    var reply by remember { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }

    fun loadList() {
        scope.launch {
            when (val r = client.listConversations()) {
                is WriteResult.Ok -> { conversations = r.value; listError = null }
                is WriteResult.Err -> { conversations = emptyList(); listError = r.message }
            }
        }
    }

    fun openThread(id: String) {
        selectedId = id
        reply = ""
        threadError = null
        threadLoading = true
        scope.launch {
            when (val r = client.getConversationThread(id)) {
                is WriteResult.Ok -> { thread = r.value; threadLoading = false }
                is WriteResult.Err -> { thread = emptyList(); threadLoading = false; threadError = r.message }
            }
            // Re-pull the list so the unread badge clears after opening.
            loadList()
        }
    }

    fun sendReply() {
        val id = selectedId ?: return
        val blocker = replyBlocker(reply)
        if (blocker != null) { threadError = blocker; return }
        sending = true
        scope.launch {
            when (val r = client.replyToConversation(id, reply.trim())) {
                is WriteResult.Ok -> { reply = ""; threadError = null; openThread(id) }
                is WriteResult.Err -> threadError = r.message
            }
            sending = false
        }
    }

    LaunchedEffect(Unit) { loadList() }

    DenPanel(
        title = "Messages",
        subtitle = "Two-way threads with kinfolk. Open a thread to read and reply.",
    ) {
        listError?.let { msg ->
            AuntieBanner(tone = AuntieBannerTone.Error, title = "Couldn't load messages", icon = Lucide.Inbox) {
                Text(text = msg, style = AuntieTheme.typography.bodySmall, color = c.error)
            }
            Spacer(Modifier.height(10.dp))
        }

        when {
            conversations == null && listError == null ->
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) { repeat(3) { ShimmerCard(height = 64.dp) } }
            conversations.isNullOrEmpty() && listError == null ->
                Text(
                    text = "No messages yet. When a kinfolk messages you from MyTribe, the thread shows up here.",
                    style = AuntieTheme.typography.bodyMedium,
                    color = c.textDim,
                )
            else -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                conversations!!.forEach { conv ->
                    val selected = conv.kinfolkId == selectedId
                    ConversationRow(conv = conv, selected = selected, onClick = {
                        if (selected) selectedId = null else openThread(conv.kinfolkId)
                    })
                    if (selected) {
                        ThreadView(
                            messages = thread,
                            loading = threadLoading,
                            error = threadError,
                            reply = reply,
                            onReply = { reply = it },
                            sending = sending,
                            onSend = { sendReply() },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun ConversationRow(conv: ConversationSummary, selected: Boolean, onClick: () -> Unit) {
    val c = AuntieTheme.colors
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(if (selected) c.primary.copy(alpha = 0.08f) else c.surface)
            .clickable { onClick() }
            .padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        if (conv.unreadForAdmin) {
            Box(modifier = Modifier.size(8.dp).clip(CircleShape).background(c.primary))
        }
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = conv.kinfolkName,
                style = AuntieTheme.typography.bodyMedium,
                color = c.textPrimary,
            )
            Text(
                text = (if (conv.lastSenderRole == "auntie") "You: " else "") + conv.lastMessagePreview,
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
                maxLines = 1,
            )
        }
        Text(text = "${conv.messageCount}", style = AuntieTheme.typography.bodySmall, color = c.textDim)
    }
}

@Composable
private fun ThreadView(
    messages: List<ThreadMessage>,
    loading: Boolean,
    error: String?,
    reply: String,
    onReply: (String) -> Unit,
    sending: Boolean,
    onSend: () -> Unit,
) {
    val c = AuntieTheme.colors
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(c.surface)
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        when {
            loading -> Text("Loading thread…", style = AuntieTheme.typography.bodySmall, color = c.textDim)
            messages.isEmpty() && error == null ->
                Text("No messages in this thread yet.", style = AuntieTheme.typography.bodySmall, color = c.textDim)
            else -> messages.forEach { m ->
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(6.dp))
                        .background(if (m.isFromAuntie) c.primary.copy(alpha = 0.10f) else c.background)
                        .padding(8.dp),
                ) {
                    Text(
                        text = if (m.isFromAuntie) "You" else "Kinfolk",
                        style = AuntieTheme.typography.bodySmall,
                        color = if (m.isFromAuntie) c.primary else c.accent,
                    )
                    Text(text = m.body, style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
                }
            }
        }
        error?.let { Text(text = it, style = AuntieTheme.typography.bodySmall, color = c.error) }
        MultilineField(
            value = reply,
            onValueChange = onReply,
            label = "Reply",
            placeholder = "Write a reply to this kinfolk.",
            minLines = 2,
        )
        PrimaryButton(
            label = "Send reply",
            onClick = onSend,
            loading = sending,
            leading = { Icon(Lucide.MessageSquare, contentDescription = null, tint = c.background, modifier = Modifier.height(14.dp).width(14.dp)) },
        )
    }
}

/**
 * Real notifications list (the `notifications` collection) with multi-select +
 * a bulk "Mark read" action wired to bulkMarkNotificationsRead. Fail-loud: load
 * errors surface; the marked count is reported via toast in the caller.
 */
@Composable
private fun NotificationsSection(
    state: FirestoreResult<List<NotificationEntry>>,
    selected: Map<String, Boolean>,
    markBusy: Boolean,
    onToggle: (String) -> Unit,
    onMarkRead: () -> Unit,
) {
    val c = AuntieTheme.colors
    val all = (state as? FirestoreResult.Data)?.value.orEmpty()
    // Only unread notifications are actionable for mark-read.
    val unread = all.filter { !it.isRead }
    val selectedCount = selected.count { it.value }

    DenPanel(
        title = "Notifications",
        subtitle = "Business alerts. Select to mark read in bulk.",
        trailing = {
            if (selectedCount > 0) {
                PrimaryButton(
                    label = if (markBusy) "Marking..." else "Mark read ($selectedCount)",
                    onClick = { if (!markBusy) onMarkRead() },
                )
            }
        },
    ) {
        when {
            state is FirestoreResult.Loading ->
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) { repeat(2) { ShimmerCard(height = 64.dp) } }
            state is FirestoreResult.Error ->
                AuntieBanner(
                    tone = AuntieBannerTone.Error,
                    title = "Couldn't load notifications",
                    icon = Lucide.Inbox,
                ) { Text(state.message, style = AuntieTheme.typography.bodySmall, color = c.error) }
            unread.isEmpty() ->
                AuntieEmptyState(
                    title = "No unread notifications",
                    message = "Business alerts land here. Bulk mark-read clears them once read.",
                    icon = Lucide.Inbox,
                    compact = true,
                )
            else -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                unread.forEach { n ->
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        AuntieCheckbox(
                            checked = selected[n._id] == true,
                            onCheckedChange = { onToggle(n._id) },
                        )
                        Column(Modifier.weight(1f)) {
                            Text(
                                text = n.key.ifBlank { "Notification" },
                                style = AuntieTheme.typography.titleSmall,
                                color = c.textPrimary,
                            )
                            val meta = listOf(n.category, n.status).filter { it.isNotBlank() }.joinToString(" · ")
                            if (meta.isNotBlank()) {
                                Text(meta, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                            }
                        }
                        Text(
                            text = shortDateTime(n.createdAt),
                            style = AuntieTheme.typography.labelSmall,
                            color = c.textFaint,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun ChannelFilterRow(selected: Channel, onSelect: (Channel) -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Channel.entries.forEach { channel ->
            AuntieChip(
                label = channel.label,
                selected = channel == selected,
                onClick = { onSelect(channel) },
                tone = AuntieChipTone.Orange,
                leading = { ChipGlyph(channel.icon, channel == selected) },
            )
        }
    }
}

/** Leading glyph for a filter chip, drawn with foundation Image (no M3 Icon in the pill). */
@Composable
private fun ChipGlyph(icon: ImageVector, active: Boolean) {
    val c = AuntieTheme.colors
    Image(
        painter = rememberVectorPainter(icon),
        contentDescription = null,
        colorFilter = ColorFilter.tint(if (active) c.primary else c.textDim),
        modifier = Modifier.size(14.dp),
    )
}

@Composable
private fun InboxRow(entry: InboxEntry, selected: Boolean, onClick: () -> Unit) {
    val c = AuntieTheme.colors
    AuntieEntityRow(
        title = entry.kinfolkName.ifBlank { entry.counterpart.ifBlank { "Unknown" } },
        subtitle = entry.preview.ifBlank { null },
        selected = selected,
        onClick = onClick,
        leading = {
            AuntieIconTile(
                icon = channelIcon(entry),
                size = 38.dp,
                tone = accentTone(entry),
            )
        },
        trailing = {
            Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(
                    text  = shortDateTime(entry.timestamp),
                    style = AuntieTheme.typography.labelSmall,
                    color = c.textFaint,
                )
                MetaRow(entry)
            }
        },
    )
}

@Composable
private fun ThreadActionsCard(
    entry: InboxEntry,
    replyBody: String,
    sending: Boolean,
    onReplyBodyChange: (String) -> Unit,
    onPlayVoicemail: () -> Unit,
    onSendReply: () -> Unit,
) {
    val c = AuntieTheme.colors
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(c.surface2)
            .border(AuntieTheme.dims.borderHairline, c.borderSoft, RoundedCornerShape(12.dp))
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(11.dp),
    ) {
        Text(
            text = "Thread actions · ${entry.channel.label}",
            style = AuntieTheme.typography.mono,
            color = c.textPrimary,
        )

        // Native outreach: tel: / sms: / mailto: launch the OS handler.
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (entry.replyTargetPhone.isNotBlank()) {
                GhostButton(
                    label    = "Call",
                    onClick  = { openUrl("tel:${entry.replyTargetPhone}") },
                    leading  = { GhostGlyph(Lucide.Phone) },
                    modifier = Modifier.weight(1f),
                )
                GhostButton(
                    label    = "Text",
                    onClick  = { openUrl("sms:${entry.replyTargetPhone}") },
                    leading  = { GhostGlyph(Lucide.MessageSquare) },
                    modifier = Modifier.weight(1f),
                )
            }
            if (entry.replyTargetEmail.isNotBlank()) {
                GhostButton(
                    label    = "Email",
                    onClick  = { openUrl("mailto:${entry.replyTargetEmail}") },
                    leading  = { GhostGlyph(Lucide.Mail) },
                    modifier = Modifier.weight(1f),
                )
            }
        }

        if (entry.channel == Channel.Voicemail) {
            GhostButton(
                label = "Play voicemail",
                onClick = onPlayVoicemail,
                enabled = entry.voicemailAudioUrl.isNotBlank(),
                leading = { GhostGlyph(Lucide.Play) },
            )
        }

        if (entry.canReply) {
            BottomBorderField(
                value = replyBody,
                onValueChange = onReplyBodyChange,
                label = "Reply via SMS",
                placeholder = "Type reply to ${entry.replyTargetPhone}",
                singleLine = false,
            )
            PrimaryButton(
                label = "Send reply",
                onClick = onSendReply,
                enabled = replyBody.isNotBlank(),
                loading = sending,
            )
        } else {
            Text(
                text = "Reply composer is currently enabled for phone-based threads only.",
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
            )
        }
    }
}

/** Leading glyph for a ghost outreach button, drawn with foundation Image (no M3 Icon). */
@Composable
private fun GhostGlyph(icon: ImageVector) {
    Image(
        painter = rememberVectorPainter(icon),
        contentDescription = null,
        colorFilter = ColorFilter.tint(AuntieTheme.colors.textDim),
        modifier = Modifier.size(14.dp),
    )
}

@Composable
private fun MetaRow(entry: InboxEntry) {
    val c = AuntieTheme.colors
    val pips = buildList<Pair<ImageVector, String>> {
        // Direction (inbound/outbound) for everything except voicemail (always inbound).
        when (entry.direction) {
            "outbound" -> add(Lucide.ArrowUpRight to "sent")
            "inbound"  -> if (entry.channel != Channel.Voicemail) add(Lucide.ArrowDownLeft to "received")
            else       -> Unit
        }
        if (entry.statusHint == "missed") {
            add(Lucide.PhoneMissed to "missed")
        }
        if (entry.statusHint == "unread") {
            add(Lucide.Voicemail to "unread")
        }
        if (entry.mediaCount > 0) {
            add(Lucide.Images to "${entry.mediaCount}")
        }
    }
    if (pips.isEmpty()) return
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(11.dp),
    ) {
        pips.forEach { (icon, label) ->
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                Image(
                    painter = rememberVectorPainter(icon),
                    contentDescription = null,
                    colorFilter = ColorFilter.tint(c.textFaint),
                    modifier = Modifier.size(11.dp),
                )
                Text(label, style = AuntieTheme.typography.labelSmall, color = c.textFaint)
            }
        }
    }
}

@Composable
private fun EmptyState(filter: Channel) {
    val (title, body) = when (filter) {
        Channel.All       -> "Inbox is quiet right now" to
            "Twilio's public-facing inbound flow comes online once the rest of AuntieOS is wired up. Until then, the only thing landing here is the occasional spam voicemail."
        Channel.Voicemail -> "No voicemails" to
            "When the public Twilio flow goes live, missed-call voicemails (and the spam) will show up here for triage."
        Channel.Call      -> "No call activity" to
            "Call records, incoming, outgoing, missed, will show up here once the call pipeline is wired through."
        Channel.Sms       -> "No SMS yet" to
            "Text threads with kinfolk land here. SMS/MMS/RCS comes online with the public Twilio flow."
        Channel.Email     -> "No emails yet" to
            "Email threads land here once the email ingestion pipeline is wired up."
    }
    AuntieEmptyState(
        title = title,
        message = body,
        icon = filter.icon,
    )
}

// ---------- mappers ----------

private fun VoicemailLog.toEntry() = InboxEntry(
    id          = _id,
    channel     = Channel.Voicemail,
    timestamp   = timestamp,
    kinfolkId   = kinfolkId,
    kinfolkName = kinfolkName,
    counterpart = callerNumber,
    preview     = transcript.take(120),
    replyTargetPhone = callerNumber,
    replyTargetEmail = "",
    voicemailAudioUrl = audioUrl,
    canReply = callerNumber.isNotBlank(),
    direction   = "",
    statusHint  = if (replyStatus == "unread") "unread" else "",
    mediaCount  = 0,
)

private fun CallLog.toEntry() = InboxEntry(
    id          = _id,
    channel     = Channel.Call,
    timestamp   = timestamp,
    kinfolkId   = kinfolkId,
    kinfolkName = kinfolkName,
    counterpart = counterpartNumber,
    preview     = transcript.take(120).ifBlank {
        when (status.lowercase()) {
            "missed"    -> "Missed call"
            "voicemail" -> "Left a voicemail"
            "answered"  -> "Call (${formatDuration(durationSec)})"
            else        -> if (status.isNotBlank()) "Call · $status" else ""
        }
    },
    replyTargetPhone = counterpartNumber,
    replyTargetEmail = "",
    voicemailAudioUrl = recordingUrl,
    canReply = counterpartNumber.isNotBlank(),
    direction   = direction,
    statusHint  = if (status.equals("missed", ignoreCase = true)) "missed" else "",
    mediaCount  = 0,
)

private fun SmsMessage.toEntry() = InboxEntry(
    id          = _id,
    channel     = Channel.Sms,
    timestamp   = timestamp,
    kinfolkId   = kinfolkId,
    kinfolkName = kinfolkName,
    counterpart = counterpartNumber,
    preview     = body.take(140),
    replyTargetPhone = counterpartNumber,
    replyTargetEmail = "",
    voicemailAudioUrl = "",
    canReply = counterpartNumber.isNotBlank(),
    direction   = direction,
    statusHint  = "",
    mediaCount  = mediaUrls.size,
)

private fun EmailMessage.toEntry(): InboxEntry {
    val person = if (direction == "outbound") toAddresses.firstOrNull().orEmpty() else fromAddress
    val previewText = listOf(subject, body).filter { it.isNotBlank() }.joinToString(" · ")
    return InboxEntry(
        id          = _id,
        channel     = Channel.Email,
        timestamp   = timestamp,
        kinfolkId   = kinfolkId,
        kinfolkName = kinfolkName,
        counterpart = person,
        preview     = previewText.take(160),
        replyTargetPhone = "",
        replyTargetEmail = person,
        voicemailAudioUrl = "",
        canReply = false,
        direction   = direction,
        statusHint  = "",
        mediaCount  = attachmentUrls.size,
    )
}

// ---------- styling helpers ----------

/** Tone form for the Den AuntieIconTile leading element. */
private fun accentTone(entry: InboxEntry): AuntieStatusTone = when (entry.channel) {
    Channel.All        -> AuntieStatusTone.Orange
    Channel.Voicemail  -> if (entry.statusHint == "unread") AuntieStatusTone.Warning else AuntieStatusTone.Orange
    Channel.Call       -> if (entry.statusHint == "missed") AuntieStatusTone.Error   else AuntieStatusTone.Orange
    Channel.Sms        -> AuntieStatusTone.Orange
    Channel.Email      -> AuntieStatusTone.Orange
}

private fun channelIcon(entry: InboxEntry): ImageVector = when (entry.channel) {
    Channel.All        -> Lucide.Inbox
    Channel.Voicemail  -> Lucide.Voicemail
    Channel.Call       -> if (entry.statusHint == "missed") Lucide.PhoneMissed else Lucide.Phone
    Channel.Sms        -> Lucide.MessageSquare
    Channel.Email      -> Lucide.Mail
}

private fun formatDuration(sec: Int): String =
    if (sec < 60) "${sec}s" else "${sec / 60}m ${sec % 60}s"

private fun shortDateTime(iso: String): String =
    runCatching {
        if (iso.length < 16) return@runCatching iso
        val month = MONTHS[iso.substring(5, 7).toInt() - 1]
        val day   = iso.substring(8, 10).trimStart('0').ifBlank { "0" }
        val time  = iso.substring(11, 16)
        "$month $day · $time"
    }.getOrDefault(iso)

private val MONTHS = listOf("Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec")
