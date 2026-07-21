package com.kinfolk.portal.screens.messages

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
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
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
import androidx.compose.ui.unit.dp
import com.kinfolk.portal.components.EmptyState
import com.kinfolk.portal.components.GlassCard
import com.kinfolk.portal.components.KinButton
import com.kinfolk.portal.components.KinField
import com.kinfolk.portal.components.KinGhostButton
import com.kinfolk.portal.components.ScreenHeader
import com.kinfolk.portal.portal.ConversationMessage
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.text.richTextToAnnotatedString
import com.kinfolk.portal.portal.PortalChat
import com.kinfolk.portal.portal.SenderRole
import com.kinfolk.portal.theme.KinfolkBrand
import com.kinfolk.portal.theme.KinfolkSpacing
import com.kinfolk.portal.theme.LocalKinfolkTypography
import kotlin.time.Clock
import kotlinx.coroutines.launch
import kotlinx.datetime.DayOfWeek
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toLocalDateTime

/**
 * Message Auntie (16.4): the kinfolk's two-way conversation with the auntie.
 * Thread is oldest-first; the kinfolk's own messages align right, the auntie's
 * left. Reading clears the kinfolk-side unread flag (server-side in
 * getMyConversation). Sending refetches the thread (no optimistic fakery).
 */
@Composable
fun MessageAuntieScreen(
    familyName: String,
    kinfolkId: String,
    portalApi: PortalApi,
    chat: PortalChat = PortalChat(),
    onBack: () -> Unit = {},
    controller: MessageAuntieController = rememberMessageAuntieController(kinfolkId, portalApi),
) {
    val type = LocalKinfolkTypography.current
    val scope = rememberCoroutineScope()
    val messages = controller.messages
    val loadError = controller.loadError
    val sendError = controller.sendError
    val assistError = controller.assistError
    var draft by remember { mutableStateOf("") }
    // Which assist button was tapped, so only that one swaps to its busy label
    // while controller.assisting is true. Cosmetic only — the re-entrancy
    // guard lives in the controller.
    var assistKind by remember { mutableStateOf<String?>(null) }

    // Chat off entirely: show the disabled state with the operator's away
    // message and never load the thread / mount the composer. (The server also
    // refuses sends when disabled; this is the UX side.)
    if (!chat.enabled) {
        Column(modifier = Modifier.fillMaxSize()) {
            ScreenHeader(title = "Message Auntie")
            Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
                EmptyState(
                    title = "Messaging is off right now",
                    message = chat.awayMessage.ifBlank {
                        "Direct messaging isn't available at the moment. Please reach out another way."
                    },
                )
            }
            Box(modifier = Modifier.fillMaxWidth().padding(KinfolkSpacing.l)) {
                KinGhostButton(label = "Back", onClick = onBack, modifier = Modifier.fillMaxWidth())
            }
        }
        return
    }

    // Within configured hours? When hours gating is off this is always true.
    val withinHours = remember(chat.hoursEnabled, chat.hours) { isWithinChatHours(chat) }
    // Effective composer cap: 0 = unlimited.
    val maxLen = chat.maxMessageLength
    val overLength = maxLen > 0 && draft.length > maxLen

    LaunchedEffect(kinfolkId) { controller.reload() }

    Column(modifier = Modifier.fillMaxSize()) {
        ScreenHeader(title = "Message Auntie")

        if (!withinHours) {
            GlassCard(
                modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l),
                dim = true,
                contentPadding = PaddingValues(KinfolkSpacing.m),
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.xs)) {
                    Text("Outside messaging hours", style = type.sansMeta, color = KinfolkBrand.KinfolkOrange)
                    Text(
                        text = chat.awayMessage.ifBlank {
                            "We're outside messaging hours. You can still write. Your Auntie will reply when she's back."
                        },
                        style = type.sansBody,
                    )
                }
            }
        }

        Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
            when {
                // Load failure with no thread yet: retryable empty state. Once a
                // thread has loaded, it stays visible even if a later refetch
                // fails — only send failures are surfaced then (banner below).
                messages == null && loadError != null -> EmptyState(
                    title = "Couldn't load your messages",
                    message = loadError,
                    actionLabel = "Retry",
                    onAction = { scope.launch { controller.reload() } },
                )
                messages == null -> Box(
                    modifier = Modifier.fillMaxSize().padding(KinfolkSpacing.l),
                    contentAlignment = Alignment.Center,
                ) { CircularProgressIndicator(color = KinfolkBrand.KinfolkOrange) }
                messages.isEmpty() -> EmptyState(
                    title = "No messages yet",
                    message = "Say hello. Your Auntie will see this and reply right here.",
                )
                else -> Column(
                    modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(KinfolkSpacing.l),
                    verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
                ) {
                    messages.forEach { MessageBubble(it) }
                }
            }
        }

        // Send-failure banner: inline, dismissible, above the composer. The
        // thread stays visible and the draft stays in the field, so "Try again"
        // simply resends it.
        if (sendError != null) {
            GlassCard(
                modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l),
                contentPadding = PaddingValues(KinfolkSpacing.m),
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = "Your message didn't send.",
                        style = type.sansBody.copy(color = KinfolkBrand.SnuggleCoral),
                        modifier = Modifier.weight(1f),
                    )
                    Text(
                        text = "Try again",
                        style = type.sansLabel.copy(color = KinfolkBrand.KinfolkOrange),
                        modifier = Modifier
                            .clickable(enabled = !controller.sending) {
                                controller.send(draft) { draft = "" }
                            }
                            .padding(KinfolkSpacing.xs),
                    )
                    IconButton(onClick = { controller.dismissSendError() }) {
                        Icon(
                            imageVector = Icons.Filled.Close,
                            contentDescription = "Dismiss",
                            tint = KinfolkBrand.NavyMuted,
                        )
                    }
                }
            }
        }

        // Assist-failure banner (O-8): same inline dismissible pattern as the
        // send banner. The draft is untouched on failure, so nothing to retry
        // here — the assist buttons stay available.
        if (assistError != null) {
            GlassCard(
                modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l),
                contentPadding = PaddingValues(KinfolkSpacing.m),
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = assistError,
                        style = type.sansBody.copy(color = KinfolkBrand.SnuggleCoral),
                        modifier = Modifier.weight(1f),
                    )
                    IconButton(onClick = { controller.dismissAssistError() }) {
                        Icon(
                            imageVector = Icons.Filled.Close,
                            contentDescription = "Dismiss",
                            tint = KinfolkBrand.NavyMuted,
                        )
                    }
                }
            }
        }

        // Composer pinned at the bottom.
        Column(
            modifier = Modifier.fillMaxWidth().padding(KinfolkSpacing.l),
            verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
        ) {
            KinField(
                value = draft,
                // Enforce the operator's max length: drop input past the cap so
                // the composer can never exceed it (server enforces too).
                onValueChange = { next -> draft = if (maxLen > 0) next.take(maxLen) else next },
                label = "Message",
                singleLine = false,
                isError = overLength,
                modifier = Modifier.fillMaxWidth(),
            )
            if (maxLen > 0) {
                Text(
                    text = "${draft.length} / $maxLen",
                    style = type.sansMeta,
                    color = if (overLength) KinfolkBrand.SnuggleCoral else KinfolkBrand.NavyMuted,
                )
            }
            // AI assist row (O-8): Polish rewrites the current draft, Suggest
            // drafts a reply from the thread. Results land in the composer for
            // the kinfolk to edit — nothing is ever sent automatically. The
            // result respects the operator's cap, same as typed input.
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                val onAssistResult: (String) -> Unit = { text ->
                    draft = if (maxLen > 0) text.take(maxLen) else text
                }
                KinGhostButton(
                    label = if (controller.assisting && assistKind == "polish") "Polishing…" else "Polish",
                    onClick = {
                        assistKind = "polish"
                        controller.polish(draft, onAssistResult)
                    },
                    enabled = !controller.assisting && !controller.sending && isSendableMessage(draft),
                    modifier = Modifier.weight(1f),
                )
                KinGhostButton(
                    label = if (controller.assisting && assistKind == "suggest") "Thinking…" else "Suggest",
                    onClick = {
                        assistKind = "suggest"
                        controller.suggestReply(onAssistResult)
                    },
                    enabled = !controller.assisting && !controller.sending && (controller.messages?.isNotEmpty() == true),
                    modifier = Modifier.weight(1f),
                )
            }
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                KinButton(
                    label = if (controller.sending) "Sending…" else "Send",
                    onClick = { controller.send(draft) { draft = "" } },
                    // Also parked while an assist is in flight: its result is
                    // about to replace the draft, so sending now would race it.
                    enabled = !controller.sending && !controller.assisting && isSendableMessage(draft) && !overLength,
                    modifier = Modifier.weight(1f),
                )
                KinGhostButton(label = "Back", onClick = onBack)
            }
        }
    }
}

/** Full lowercase day names keyed by [DayOfWeek], matching the businessHours
 *  map key convention (e.g. "monday"). */
private val DAY_KEYS = mapOf(
    DayOfWeek.MONDAY to "monday",
    DayOfWeek.TUESDAY to "tuesday",
    DayOfWeek.WEDNESDAY to "wednesday",
    DayOfWeek.THURSDAY to "thursday",
    DayOfWeek.FRIDAY to "friday",
    DayOfWeek.SATURDAY to "saturday",
    DayOfWeek.SUNDAY to "sunday",
)

/**
 * True when the current local time falls inside the configured chat window.
 *
 * - hours gating off → always true.
 * - today's range missing/blank → outside hours (closed that day).
 * - range "HH:MM-HH:MM": inclusive of start, exclusive of end; malformed →
 *   treated as open (fail-open, since the server is the real gate).
 * [now] is injectable for tests.
 */
fun isWithinChatHours(
    chat: PortalChat,
    now: kotlinx.datetime.LocalDateTime =
        Clock.System.now().toLocalDateTime(TimeZone.currentSystemDefault()),
): Boolean {
    if (!chat.hoursEnabled) return true
    val dayKey = DAY_KEYS[now.dayOfWeek] ?: return false
    val range = chat.hours[dayKey]?.takeIf { it.isNotBlank() } ?: return false
    val parts = range.split("-")
    if (parts.size != 2) return true // malformed → fail-open
    val start = parseMinutes(parts[0]) ?: return true
    val end = parseMinutes(parts[1]) ?: return true
    val nowMin = now.hour * 60 + now.minute
    return nowMin in start until end
}

/** Parses "HH:MM" to minutes-since-midnight; null if malformed. */
private fun parseMinutes(s: String): Int? {
    val hm = s.trim().split(":")
    if (hm.size != 2) return null
    val h = hm[0].toIntOrNull() ?: return null
    val m = hm[1].toIntOrNull() ?: return null
    if (h !in 0..23 || m !in 0..59) return null
    return h * 60 + m
}

@Composable
private fun MessageBubble(message: ConversationMessage) {
    val type = LocalKinfolkTypography.current
    val mine = message.senderRole == SenderRole.Kinfolk
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start,
    ) {
        GlassCard(
            modifier = Modifier.widthIn(max = 320.dp),
            dim = !mine,
            contentPadding = PaddingValues(KinfolkSpacing.m),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    text = if (mine) "You" else "Auntie",
                    style = type.sansMeta,
                    color = if (mine) KinfolkBrand.KinfolkOrange else KinfolkBrand.PackPink,
                )
                Text(text = richTextToAnnotatedString(message.body), style = type.sansBody)
                // Read receipt for a kinfolk's own sent message — mirrors the
                // "Sent"/"Seen" pattern of every mainstream chat app. Only
                // shown on `mine` bubbles: a kinfolk always knows they've
                // read the auntie's messages (reading this screen IS that),
                // so a receipt on the other side would be redundant noise.
                if (mine) {
                    Text(
                        text = if (message.readAt != null) "Seen" else "Sent",
                        style = type.sansMeta,
                        color = KinfolkBrand.KinfolkOrange.copy(alpha = 0.6f),
                    )
                }
            }
        }
    }
}
