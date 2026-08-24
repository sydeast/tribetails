package com.tribetails.auntieos.ui.inbox

import com.composables.icons.lucide.*
import com.composables.icons.lucide.Lucide
import android.net.Uri
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.browser.customtabs.CustomTabsIntent
import androidx.lifecycle.viewmodel.compose.viewModel
import com.tribetails.auntieos.AuntieOSApp
import com.tribetails.auntieos.config.LocalFeatureFlags
import com.tribetails.auntieos.data.model.CallLog
import com.tribetails.auntieos.data.model.EmailMessage
import com.tribetails.auntieos.data.model.SmsMessage
import com.tribetails.auntieos.data.model.VoicemailLog
import com.tribetails.auntieos.ui.components.*
import com.tribetails.auntieos.ui.components.AuntiePullRefresh
import com.tribetails.auntieos.ui.theme.*
import com.tribetails.auntieos.ui.theme.AuntieTheme

// ─────────────────────────────────────────────────────────────────────────────
// Den-redesign port of the web Inbox screen: the kinfolk<->auntie message
// threads (MessagesSection) above the Twilio voicemail / call / SMS / email
// surface. Bulk mark-read covers the MESSAGE THREADS, via markAllThreadsRead.
// The four Twilio channels still have no shared per-entry read model, so they
// keep the per-entry reply / mark path and no bulk control.
// ─────────────────────────────────────────────────────────────────────────────

internal enum class Channel(val label: String, val icon: ImageVector) {
    All       ("All",        Lucide.Inbox),
    Voicemail ("Voicemails", Lucide.Voicemail),
    Call      ("Calls",      Lucide.Phone),
    Sms       ("SMS",        Lucide.MessageSquare),
    Email     ("Emails",     Lucide.Mail),
}

internal data class InboxEntry(
    val id: String,
    val channel: Channel,
    val timestamp: String,
    val kinfolkName: String,
    val counterpart: String,
    val preview: String,
    val direction: String,
    val statusHint: String,
    val mediaCount: Int,
    val replyPhone: String,
    val kinfolkId: String?,
    val voicemailId: String,
    val playbackUrl: String,
)

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun InboxScreen(
    viewModel: InboxViewModel = viewModel {
        InboxViewModel(AuntieOSApp.instance.repository)
    },
    onBack: (() -> Unit)? = null,
) {
    val voicemails by viewModel.voicemails.collectAsState()
    val calls       by viewModel.calls.collectAsState()
    val sms         by viewModel.sms.collectAsState()
    val emails      by viewModel.emails.collectAsState()
    val isLoading   by viewModel.isLoading.collectAsState()
    val error       by viewModel.error.collectAsState()
    val conversations by viewModel.conversations.collectAsState()
    val conversationsLoading by viewModel.conversationsLoading.collectAsState()
    val selectedConversationId by viewModel.selectedConversationId.collectAsState()
    val thread by viewModel.thread.collectAsState()
    val threadLoading by viewModel.threadLoading.collectAsState()
    val conversationError by viewModel.conversationError.collectAsState()
    val isReplying by viewModel.isReplying.collectAsState()
    val bulkReadResult by viewModel.bulkReadResult.collectAsState()
    val bulkReadInFlight by viewModel.bulkReadInFlight.collectAsState()

    var filter by remember { mutableStateOf(Channel.All) }
    var toastMessage  by remember { mutableStateOf<String?>(null) }
    var toastKind     by remember { mutableStateOf(ToastKind.Info) }
    val context = LocalContext.current
    var selectedEntry by remember { mutableStateOf<InboxEntry?>(null) }
    var replyBody by remember { mutableStateOf("") }

    LaunchedEffect(Unit) { viewModel.refresh() }
    LaunchedEffect(error) {
        error?.let {
            toastMessage = "Couldn't load Inbox: $it"
            toastKind    = ToastKind.Error
            viewModel.clearError()
        }
    }
    LaunchedEffect(Unit) {
        viewModel.actionResult.collect { msg ->
            toastMessage = msg
            toastKind    = ToastKind.Info
        }
    }

    AuntieScreenScaffold(title = "Inbox", onBack = onBack) {
      Box(modifier = Modifier.fillMaxSize()) {
        AuntiePullRefresh(
            isRefreshing = isLoading,
            onRefresh    = { viewModel.refresh() },
            modifier     = Modifier.fillMaxSize(),
        ) {
            LazyColumn(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(horizontal = 16.dp),
                verticalArrangement = Arrangement.spacedBy(20.dp),
                contentPadding = PaddingValues(top = 8.dp, bottom = 24.dp),
            ) {
                item {
                    DenScreenHeading(
                        kicker   = "The Den · Inbox",
                        title    = "Inbox",
                        // Operator-facing UI chrome (no kinfolk-facing copy).
                        subtitle = "Voicemails, calls, SMS, and emails, everywhere kinfolk reach out.",
                    )
                }

                // Summary stat cards, one per channel, stacked in a wrapping row for
                // phone width. Counts come straight from the four real VM streams.
                item {
                    InboxStatRow(
                        voicemailCount = voicemails.size,
                        callCount      = calls.size,
                        smsCount       = sms.size,
                        emailCount     = emails.size,
                    )
                }

                // Stage 2 step 7: two-way kinfolk<->auntie message threads.
                item {
                    MessagesSection(
                        conversations = conversations,
                        loading = conversationsLoading,
                        selectedId = selectedConversationId,
                        thread = thread,
                        threadLoading = threadLoading,
                        error = conversationError,
                        isReplying = isReplying,
                        bulkReadResult = bulkReadResult,
                        bulkReadInFlight = bulkReadInFlight,
                        onOpen = viewModel::openConversation,
                        onReply = viewModel::sendReply,
                        onMarkAllRead = viewModel::markAllThreadsRead,
                    )
                }

                // Bulk mark-read exists for MESSAGE THREADS (above, via the
                // markAllThreadsRead callable) and for the Notifications screen's
                // own `notifications` collection. It deliberately does NOT exist
                // for the Twilio voicemail/call/SMS/email section below: those
                // four channels have no shared per-entry read model, so a button
                // there would have nothing honest to write (page-specs/20-inbox.md
                // item 6 keeps it dark until `markAllInboxRead` is built).

                item {
                    val entries = buildList {
                        addAll(voicemails.map { it.toEntry() })
                        addAll(calls.map { it.toEntry() })
                        addAll(sms.map { it.toEntry() })
                        addAll(emails.map { it.toEntry() })
                    }
                        .sortedByDescending { it.timestamp }
                        .filter { filter == Channel.All || it.channel == filter }

                    DenPanel(
                        title = "Conversations",
                        subtitle = "Tap a thread to reply, call, or play a voicemail.",
                    ) {
                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            ChannelFilterRow(selected = filter, onSelect = { filter = it })

                            when {
                                isLoading && entries.isEmpty() ->
                                    EmptyHint("Loading conversations…")

                                entries.isEmpty() ->
                                    EmptyState(filter)

                                else ->
                                    entries.forEachIndexed { index, entry ->
                                        InboxRow(
                                            entry = entry,
                                            showDivider = index < entries.lastIndex,
                                            onClick = {
                                                selectedEntry = entry
                                                replyBody = ""
                                            },
                                        )
                                    }
                            }
                        }
                    }
                }
            }
        }

        StatusToast(
            visible   = toastMessage != null,
            message   = toastMessage ?: "",
            kind      = toastKind,
            onDismiss = { toastMessage = null },
            modifier  = Modifier
                .align(Alignment.BottomCenter)
                .padding(bottom = 16.dp, start = 16.dp, end = 16.dp),
        )
      }
    }

    if (selectedEntry != null) {
        val entry = selectedEntry ?: return
        val canReply = entry.channel == Channel.Sms || entry.channel == Channel.Voicemail
        AuntieModal(
            onDismissRequest = { selectedEntry = null },
            title = entry.kinfolkName.ifBlank { entry.counterpart.ifBlank { "Inbox thread" } },
            confirmButton = {
                AuntieTextBtn(
                    onClick = {
                        viewModel.sendSmsReply(
                            recipientPhone = entry.replyPhone,
                            body = replyBody,
                            kinfolkId = entry.kinfolkId,
                            voicemailId = entry.voicemailId.takeIf { it.isNotBlank() }
                        )
                        selectedEntry = null
                    },
                    enabled = canReply && replyBody.isNotBlank() && entry.replyPhone.isNotBlank()
                ) { Text("Send Reply") }
            },
            dismissButton = {
                AuntieTextBtn(onClick = { selectedEntry = null }) { Text("Close") }
            }
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                if (entry.preview.isNotBlank()) {
                    Text(entry.preview, style = AuntieTheme.typography.bodyMedium)
                }
                if (entry.channel == Channel.Voicemail && entry.playbackUrl.isNotBlank()) {
                    PrimaryButton(
                        label = "Play voicemail",
                        onClick = { openExternalUrl(context, entry.playbackUrl) },
                        modifier = Modifier.fillMaxWidth()
                    )
                }

                // ── the two no-reply endings, in the BODY not the button bar ──
                //
                // Mark read says somebody listened. Dismiss says this one never
                // needed an answer at all: a robocall, a misdial, ten seconds of
                // somebody's pocket. `dismissed` has been on VoicemailLog and in
                // every reader since launch with no client able to write it, so
                // until now the only way to clear one of those off the waiting
                // count was to call it "read" — which quietly turns that word
                // into "seen and ignored" for every other row too.
                //
                // They moved out of `dismissButton` because a fourth control in
                // that bar (Send Reply / Mark read / Dismiss / Close) does not
                // fit a phone, and because the React sheet puts the same pair in
                // its body. Each is rendered only when it would CHANGE the
                // record — Mark read only from `unread`, Dismiss on anything not
                // already dismissed or already replied (issue #581: see
                // `canDismissVoicemail` below) — so neither is ever a no-op
                // round-trip, and neither invites a tap the Firestore rule on
                // `voicemails/{id}` is going to refuse anyway. The live
                // observeVoicemails listener carries the new state back and the
                // row restyles itself, which is why both close the modal rather
                // than waiting on a result here.
                if (entry.channel == Channel.Voicemail && entry.voicemailId.isNotBlank()) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (entry.statusHint == "unread") {
                            GhostButton(
                                label = "Mark read",
                                onClick = {
                                    viewModel.markVoicemailRead(entry.voicemailId)
                                    selectedEntry = null
                                },
                                modifier = Modifier.weight(1f),
                            )
                        }
                        if (canDismissVoicemail(entry.statusHint)) {
                            GhostButton(
                                label = "Dismiss",
                                onClick = {
                                    viewModel.markVoicemailDismissed(entry.voicemailId)
                                    selectedEntry = null
                                },
                                modifier = Modifier.weight(1f),
                            )
                        }
                    }
                }

                if (canReply) {
                    AuntieField(
                        value = replyBody,
                        onValueChange = { replyBody = it },
                        label = "Reply",
                        singleLine = false,
                        minLines = 2,
                        modifier = Modifier.fillMaxWidth(),
                    )
                } else {
                    Text(
                        "Reply is currently enabled for SMS and voicemail threads.",
                        style = AuntieTheme.typography.bodySmall,
                        color = AuntieTheme.colors.textDim
                    )
                }
            }
        }
    }
}

@Composable
private fun InboxStatRow(
    voicemailCount: Int,
    callCount: Int,
    smsCount: Int,
    emailCount: Int,
) {
    // Stacked vertically as two rows of two for phone width.
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            StatCard(
                label = "Voicemails",
                value = voicemailCount.toString(),
                trend = "in this view",
                tone = AuntieStatusTone.Orange,
                modifier = Modifier.weight(1f),
            )
            StatCard(
                label = "Calls",
                value = callCount.toString(),
                trend = "in this view",
                tone = AuntieStatusTone.Teal,
                modifier = Modifier.weight(1f),
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            StatCard(
                label = "SMS",
                value = smsCount.toString(),
                trend = "in this view",
                tone = AuntieStatusTone.Purple,
                modifier = Modifier.weight(1f),
            )
            StatCard(
                label = "Emails",
                value = emailCount.toString(),
                trend = "in this view",
                tone = AuntieStatusTone.Success,
                modifier = Modifier.weight(1f),
            )
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
                selected = channel == selected,
                onClick  = { onSelect(channel) },
                label    = channel.label,
            )
        }
    }
}

@Composable
private fun InboxRow(entry: InboxEntry, showDivider: Boolean, onClick: () -> Unit) {
    AuntieEntityRow(
        title = entry.kinfolkName.ifBlank { entry.counterpart.ifBlank { "Unknown" } },
        subtitle = entry.preview.ifBlank { null },
        showDivider = showDivider,
        onClick = onClick,
        leading = {
            AuntieIconTile(
                icon = channelIcon(entry),
                size = 38.dp,
                tone = accentTone(entry),
            )
        },
        trailing = {
            Column(
                horizontalAlignment = Alignment.End,
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Text(
                    text  = shortDateTime(entry.timestamp),
                    style = AuntieTheme.typography.labelSmall,
                    color = AuntieTheme.colors.textFaint,
                )
                MetaRow(entry)
            }
        },
    )
}

@Composable
private fun MetaRow(entry: InboxEntry) {
    val pips = buildList<Triple<ImageVector, String, AuntieStatusTone>> {
        when (entry.direction) {
            "outbound" -> add(Triple(Lucide.PhoneOutgoing, "sent", AuntieStatusTone.Muted))
            "inbound"  -> if (entry.channel != Channel.Voicemail) {
                add(Triple(Lucide.PhoneIncoming, "received", AuntieStatusTone.Muted))
            }
            else       -> Unit
        }
        if (entry.statusHint == "missed") add(Triple(Lucide.PhoneMissed, "missed", AuntieStatusTone.Error))
        if (entry.statusHint == "unread") add(Triple(Lucide.Voicemail, "unread", AuntieStatusTone.Warning))
        // Muted, and the row stays in the list. Dismissing marks a voicemail;
        // it does not delete it from the operator's view, and this pip is how
        // the next person scrolling past can tell a closed-out row from an
        // untouched one.
        if (entry.statusHint == "dismissed") add(Triple(Lucide.CircleSlash, "dismissed", AuntieStatusTone.Muted))
        if (entry.mediaCount > 0)         add(Triple(Lucide.Paperclip, "${entry.mediaCount}", AuntieStatusTone.Muted))
    }
    if (pips.isEmpty()) return
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        pips.forEach { (icon, label, tone) ->
            AuntieStatusPill(
                label = label,
                tone = tone,
                leadingIcon = icon,
            )
        }
    }
}

@Composable
private fun EmptyState(filter: Channel) {
    val (title, body) = when (filter) {
        Channel.All       -> "Inbox is quiet right now" to
            "Twilio's public-facing inbound flow comes online once the rest of AuntieOS is wired up. Until then, the only thing landing here is the occasional spam voicemail."
        Channel.Voicemail -> "No voicemails" to
            "Once the public Twilio flow goes live, missed-call voicemails (and the spam) will show up here for triage."
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

/**
 * Issue #581: Dismiss is offered only while the voicemail is neither already
 * dismissed (pressing it again would write the state it is already in) nor
 * already replied (pressing it would overwrite `repliedAt`/`replyLogId` with
 * no way back). `internal` so a JVM unit test can pin the truth table without
 * standing up a Compose test harness - the same reason `toEntry()` below is
 * `internal` rather than `private`.
 */
internal fun canDismissVoicemail(statusHint: String): Boolean =
    statusHint != "dismissed" && statusHint != "replied"

internal fun VoicemailLog.toEntry() = InboxEntry(
    id          = id,
    channel     = Channel.Voicemail,
    timestamp   = timestamp,
    kinfolkName = kinfolkName,
    counterpart = callerNumber,
    preview     = transcript.take(120),
    direction   = "",
    // Three states are carried rather than collapsed to "". `dismissed` has to
    // reach the row (so the list can say somebody closed this out, as opposed
    // to nobody having looked) and the modal (so Dismiss gates itself off when
    // it would write the state the document is already in). `replied` is
    // carried for the same modal-gating reason (issue #581): before this, a
    // replied voicemail fell into the same "" bucket as a merely-read one, so
    // neither Mark read's `== "unread"` check nor Dismiss's `!= "dismissed"`
    // check could tell a replied voicemail apart from one nobody had answered,
    // and Dismiss rendered on it — a stray tap then blanked repliedAt /
    // replyLogId. `replied` matches none of the pip checks in `MetaRow` below,
    // so this carries no visual change; it only gives the modal something to
    // gate on. Lower-cased on the way in because casing on this field is
    // unenforced — the Twilio webhooks, both admin clients and the python
    // reconcile pipeline all write it, which is why the React reader
    // normalizes it too.
    statusHint  = when (replyStatus.trim().lowercase()) {
        "unread"    -> "unread"
        "replied"   -> "replied"
        "dismissed" -> "dismissed"
        else        -> ""
    },
    mediaCount  = 0,
    replyPhone  = callerNumber,
    kinfolkId   = kinfolkId,
    voicemailId = id,
    playbackUrl = audioUrl,
)

private fun CallLog.toEntry() = InboxEntry(
    id          = id,
    channel     = Channel.Call,
    timestamp   = timestamp,
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
    direction   = direction,
    statusHint  = if (status.equals("missed", ignoreCase = true)) "missed" else "",
    mediaCount  = 0,
    replyPhone  = counterpartNumber,
    kinfolkId   = kinfolkId,
    voicemailId = "",
    playbackUrl = recordingUrl,
)

private fun SmsMessage.toEntry() = InboxEntry(
    id          = id,
    channel     = Channel.Sms,
    timestamp   = timestamp,
    kinfolkName = kinfolkName,
    counterpart = counterpartNumber,
    preview     = body.take(140),
    direction   = direction,
    statusHint  = "",
    mediaCount  = mediaUrls.size,
    replyPhone  = counterpartNumber,
    kinfolkId   = kinfolkId,
    voicemailId = "",
    playbackUrl = "",
)

private fun EmailMessage.toEntry(): InboxEntry {
    val person = if (direction == "outbound") toAddresses.firstOrNull().orEmpty() else fromAddress
    val previewText = listOf(subject, body).filter { it.isNotBlank() }.joinToString(" · ")
    return InboxEntry(
        id          = id,
        channel     = Channel.Email,
        timestamp   = timestamp,
        kinfolkName = kinfolkName,
        counterpart = person,
        preview     = previewText.take(160),
        direction   = direction,
        statusHint  = "",
        mediaCount  = attachmentUrls.size,
        replyPhone  = "",
        kinfolkId   = kinfolkId,
        voicemailId = "",
        playbackUrl = "",
    )
}

// ---------- styling helpers ----------

/** Tone form for the Den AuntieIconTile leading element. */
private fun accentTone(entry: InboxEntry): AuntieStatusTone = when (entry.channel) {
    Channel.All       -> AuntieStatusTone.Orange
    Channel.Voicemail -> if (entry.statusHint == "unread") AuntieStatusTone.Warning else AuntieStatusTone.Orange
    Channel.Call      -> if (entry.statusHint == "missed") AuntieStatusTone.Error   else AuntieStatusTone.Orange
    Channel.Sms       -> AuntieStatusTone.Orange
    Channel.Email     -> AuntieStatusTone.Orange
}

private fun channelIcon(entry: InboxEntry): ImageVector = when (entry.channel) {
    Channel.All       -> Lucide.Inbox
    Channel.Voicemail -> Lucide.Voicemail
    Channel.Call      -> if (entry.statusHint == "missed") Lucide.PhoneMissed else Lucide.Phone
    Channel.Sms       -> Lucide.MessageSquare
    Channel.Email     -> Lucide.Mail
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

private fun openExternalUrl(context: android.content.Context, url: String) {
    if (url.isBlank()) return
    CustomTabsIntent.Builder().build().launchUrl(context, Uri.parse(url))
}
// ─────────────────────────────────────────────────────────────────────────────
// Messages (Stage 2 step 7 / Message Auntie 16.4): two-way kinfolk<->auntie
// threads. listConversations -> thread list; opening a thread fetches messages
// (and clears the admin unread) and reveals a reply box wired to
// replyToConversation. Fail-loud: load / send errors surface in a banner.
//
// Grouped WAITING-FIRST (groupThreadsByWaiting, parity with the React admin's
// src/lib/inboxFormat.ts): the operator's first question is who is waiting on
// them, and a flat newest-first list buries three live threads under ninety
// finished ones. Both headers always render, empty or not, for the reason
// spelled out on that function.
//
// ...UNLESS the operator has turned `auntieos.inbox.waitingSections` off, in
// which case `arrangeThreads` hands back the one headerless run this screen
// showed before #301, and the A/B trial can be judged on android as well as on
// web. One Firestore doc feeds both clients, so the choice is made once. The
// flag arrives through `LocalFeatureFlags`, which android resolves at app
// start, so a flip shows up on the next app load.
//
// "Mark all read" clears every waiting thread through the server and re-reads
// the list; it is offered only when something is genuinely waiting. It is on
// BOTH sides of the flag: the flag picks a layout, it does not take a working
// control away.
// ─────────────────────────────────────────────────────────────────────────────
@Composable
private fun MessagesSection(
    conversations: List<ConversationSummary>,
    loading: Boolean,
    selectedId: String?,
    thread: List<ThreadMessage>,
    threadLoading: Boolean,
    error: String?,
    isReplying: Boolean,
    bulkReadResult: String?,
    bulkReadInFlight: Boolean,
    onOpen: (String) -> Unit,
    onReply: (String) -> Unit,
    onMarkAllRead: () -> Unit,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    var reply by remember { mutableStateOf("") }
    DenPanel(
        title = "Messages",
        subtitle = "Two-way threads with kinfolk. Open a thread to read and reply.",
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(dims.space3)) {
            error?.let { msg ->
                AuntieBanner(tone = AuntieBannerTone.Error, icon = Lucide.MessageSquare) {
                    Text(text = msg, style = AuntieTheme.typography.bodySmall, color = c.error)
                }
            }
            bulkReadResult?.let { msg ->
                Text(msg, style = AuntieTheme.typography.bodySmall, color = c.textDim)
            }
            // Offered only when something is actually waiting: a control that
            // would clear nothing is a dead control.
            if (unreadConversationCount(conversations) > 0) {
                GhostButton(
                    label = if (bulkReadInFlight) "Marking…" else "Mark all read",
                    onClick = onMarkAllRead,
                    enabled = !bulkReadInFlight,
                )
            }
            when {
                loading && conversations.isEmpty() ->
                    Text("Loading messages…", style = AuntieTheme.typography.bodySmall, color = c.textDim)
                conversations.isEmpty() ->
                    Text(
                        "No messages yet. When a kinfolk messages you from MyTribe, the thread shows up here.",
                        style = AuntieTheme.typography.bodyMedium,
                        color = c.textDim,
                    )
                else -> arrangeThreads(
                    conversations,
                    LocalFeatureFlags.current.inboxWaitingSections,
                ).forEach { section ->
                  // FLAT is the whole list under no header, the arrangement
                  // before #301; the two real sections keep their headers and
                  // their empty lines.
                  if (section.key != ThreadSectionKey.FLAT) {
                      Text(
                          section.label,
                          style = AuntieTheme.typography.labelLarge,
                          color = if (section.key == ThreadSectionKey.WAITING) c.textPrimary else c.textDim,
                      )
                      if (section.threads.isEmpty()) {
                          // The header stays: an absent section reads the same as
                          // one that has not loaded.
                          Text(
                              if (section.key == ThreadSectionKey.WAITING) "Nothing is waiting on a reply."
                              else "No answered threads yet.",
                              style = AuntieTheme.typography.bodySmall,
                              color = c.textDim,
                          )
                      }
                  }
                  section.threads.forEach { conv ->
                    val selected = conv.kinfolkId == selectedId
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(8.dp))
                            .background(if (selected) c.primary.copy(alpha = 0.08f) else c.surface)
                            .clickable { reply = ""; onOpen(conv.kinfolkId) }
                            .padding(12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        if (conv.unreadForAdmin) {
                            Box(modifier = Modifier.size(8.dp).clip(CircleShape).background(c.primary))
                        }
                        Column(modifier = Modifier.weight(1f)) {
                            Text(conv.kinfolkName, style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
                            Text(
                                (if (conv.lastSenderRole == "auntie") "You: " else "") + conv.lastMessagePreview,
                                style = AuntieTheme.typography.bodySmall,
                                color = c.textDim,
                                maxLines = 1,
                            )
                        }
                        Text("${conv.messageCount}", style = AuntieTheme.typography.bodySmall, color = c.textDim)
                    }
                    if (selected) {
                        Column(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(8.dp))
                                .background(c.surface)
                                .padding(12.dp),
                            verticalArrangement = Arrangement.spacedBy(dims.space2),
                        ) {
                            when {
                                threadLoading -> Text("Loading thread…", style = AuntieTheme.typography.bodySmall, color = c.textDim)
                                thread.isEmpty() -> Text("No messages in this thread yet.", style = AuntieTheme.typography.bodySmall, color = c.textDim)
                                else -> thread.forEach { m ->
                                    Column(
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .clip(RoundedCornerShape(6.dp))
                                            .background(if (m.isFromAuntie) c.primary.copy(alpha = 0.10f) else c.background)
                                            .padding(8.dp),
                                    ) {
                                        Text(
                                            if (m.isFromAuntie) "You" else "Kinfolk",
                                            style = AuntieTheme.typography.bodySmall,
                                            color = if (m.isFromAuntie) c.primary else c.accent,
                                        )
                                        Text(m.body, style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
                                    }
                                }
                            }
                            AuntieField(
                                value = reply,
                                onValueChange = { reply = it },
                                label = "Reply",
                                placeholder = "Write a reply to this kinfolk.",
                                singleLine = false,
                                minLines = 2,
                                modifier = Modifier.fillMaxWidth(),
                            )
                            PrimaryButton(
                                label = "Send reply",
                                onClick = { onReply(reply); reply = "" },
                                enabled = !isReplying,
                                loading = isReplying,
                                leading = { Icon(Lucide.MessageSquare, contentDescription = null, tint = c.background, modifier = Modifier.size(14.dp)) },
                            )
                        }
                    }
                  }
                }
            }
        }
    }
}
