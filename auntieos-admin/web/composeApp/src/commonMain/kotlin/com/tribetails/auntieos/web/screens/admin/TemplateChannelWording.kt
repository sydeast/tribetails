package com.tribetails.auntieos.web.screens.admin

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.web.data.PushWording
import com.tribetails.auntieos.web.data.TemplateChannels
import com.tribetails.auntieos.web.data.TemplateService
import com.tribetails.auntieos.web.data.WORDING_FIELD_PUSH_BODY
import com.tribetails.auntieos.web.data.WORDING_FIELD_PUSH_TITLE
import com.tribetails.auntieos.web.data.WORDING_FIELD_TEXT
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.data.wordingFieldErrors
import com.tribetails.auntieos.web.observability.rememberReportingScope
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.AuntieChip
import com.tribetails.auntieos.web.ui.components.AuntieChipTone
import com.tribetails.auntieos.web.ui.components.AuntieFieldLabel
import com.tribetails.auntieos.web.ui.components.AuntieSpinner
import com.tribetails.auntieos.web.ui.components.GhostButton
import com.tribetails.auntieos.web.ui.components.MultilineFieldValue
import com.tribetails.auntieos.web.ui.components.PrimaryButton
import kotlinx.coroutines.launch

/**
 * #1935: the text message and push notification wording of a template, beside
 * its email. Until this, both were stored and sent and no screen showed them.
 *
 * One composable for every place the Template Bank opens a template, so the
 * email editor above it can change without this moving. It owns its own load
 * and its own two Save buttons: the email's Save writes the email only, and a
 * channel save sends that channel alone.
 *
 * The server decides everything the screen cannot know: whether the
 * notification sends a channel at all, the limits, the fields it fills in and
 * the reason a save was refused. This file pre-checks empty and too long, in
 * the server's own words, and nothing else.
 */

/** The three channels, as the operator reads them. */
const val CHANNEL_EMAIL = "Email"
const val CHANNEL_TEXT = "Text message"
const val CHANNEL_PUSH = "Push notification"

internal const val CHANNEL_NOT_SET = "Not set"
internal const val CHANNEL_LOADING = "Loading the text message and push notification"
internal const val SAVE_TEMPLATE_FIRST = "Save this template first."

/** A channel this section edits. Email is the editor above it. */
internal enum class WordingChannel(
    val title: String,
    /** "...so it has no <noun>." */
    val noun: String,
    val notSent: String,
    val addLabel: String,
    val saveLabel: String,
    val savedNotice: String,
) {
    TEXT(
        title = CHANNEL_TEXT,
        noun = "text message",
        notSent = "This notification is not sent by text message.",
        addLabel = "Add text message",
        saveLabel = "Save text message",
        savedNotice = "Text message saved.",
    ),
    PUSH(
        title = CHANNEL_PUSH,
        noun = "push notification",
        notSent = "This notification is not sent as a push notification.",
        addLabel = "Add push notification",
        saveLabel = "Save push notification",
        savedNotice = "Push notification saved.",
    ),
}

/**
 * Why a channel has no wording and none can be added, or null when the
 * notification sends it (so it is either set, or can be added).
 */
internal fun channelNotSetReason(
    channel: WordingChannel,
    templateSaved: Boolean,
    supported: Boolean,
    notificationLabel: String?,
): String? = when {
    !templateSaved -> SAVE_TEMPLATE_FIRST
    supported -> null
    notificationLabel == null -> "No notification sends this template, so it has no ${channel.noun}."
    else -> channel.notSent
}

/**
 * The two problems this screen can see without asking: nothing written, or
 * more than the limit. The sentences are the server's, so a field reads the
 * same whichever side caught it. [max] of 0 or less means the limit is not
 * known here and is left to the server.
 */
internal fun wordingPrecheck(label: String, value: String, max: Int): String? {
    val length = value.trim().length
    return when {
        length == 0 -> "$label cannot be empty."
        max > 0 && length > max -> "$label is $length characters. The limit is $max."
        else -> null
    }
}

/** "12 of 1600 characters", or just the count when the limit is not known. */
internal fun wordingCounter(value: String, max: Int): String {
    val length = value.trim().length
    return if (max > 0) "$length of $max characters" else "$length characters"
}

/** The GSM-7 alphabet: 160 to a text. The extension set takes two places each. */
private const val GSM7_BASIC =
    "@£\$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
        "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"
private const val GSM7_EXTENDED = "^{}\\[~]|€\u000C"

/** How many texts a message goes out as, and whether a special character shortened each one. */
internal data class SmsSegments(val segments: Int, val unicode: Boolean)

/**
 * The same count as the web and Android editors: 160 places in one text or 153
 * each when split, 70 or 67 (UTF-16 units) once any character is outside the
 * plain alphabet. Every GSM-7 character is a single UTF-16 unit, so half of an
 * emoji is already "outside" and the walk can go unit by unit.
 */
internal fun smsSegments(text: String): SmsSegments {
    val value = text.trim()
    if (value.isEmpty()) return SmsSegments(0, false)
    var places = 0
    for (ch in value) {
        when {
            GSM7_BASIC.indexOf(ch) >= 0 -> places += 1
            GSM7_EXTENDED.indexOf(ch) >= 0 -> places += 2
            else -> {
                val units = value.length
                return SmsSegments(if (units <= 70) 1 else (units + 66) / 67, true)
            }
        }
    }
    return SmsSegments(if (places <= 160) 1 else (places + 152) / 153, false)
}

/** "Sends as 2 texts.", or null when nothing is typed. */
internal fun smsSegmentHint(text: String): String? {
    val (segments, unicode) = smsSegments(text)
    if (segments == 0) return null
    val count = if (segments == 1) "Sends as 1 text." else "Sends as $segments texts."
    return if (unicode) "$count An emoji or special character makes each text shorter." else count
}

internal sealed interface ChannelsLoad {
    data object Loading : ChannelsLoad
    data class Failed(val message: String) : ChannelsLoad
    data class Ready(val channels: TemplateChannels) : ChannelsLoad
}

/** A section title: "Email" above the email editor, and the two below it. */
@Composable
fun TemplateChannelTitle(text: String, modifier: Modifier = Modifier) {
    Text(text, style = AuntieTheme.typography.titleSmall, color = AuntieTheme.colors.textPrimary, modifier = modifier)
}

/**
 * The Text message and Push notification sections for [templateId].
 *
 * [templateId] null is a template that has not been saved yet: nothing is
 * asked of the server and both read "Not set". [editable] false is the
 * read-only viewer: the wording is shown and nothing can be changed.
 */
@Composable
fun TemplateChannelWording(
    templateId: String?,
    service: TemplateService,
    modifier: Modifier = Modifier,
    editable: Boolean = true,
) {
    TemplateChannelWording(
        templateId = templateId,
        load = { service.getTemplateChannels(it) },
        save = { id, text, push -> service.saveTemplateChannels(id, text, push) },
        modifier = modifier,
        editable = editable,
    )
}

/** The same section with the two calls handed in, so a test can hold one in flight. */
@Composable
internal fun TemplateChannelWording(
    templateId: String?,
    load: suspend (String) -> WriteResult<TemplateChannels>,
    save: suspend (String, String?, PushWording?) -> WriteResult<TemplateChannels>,
    modifier: Modifier = Modifier,
    editable: Boolean = true,
) {
    val c = AuntieTheme.colors
    var state by remember(templateId) { mutableStateOf<ChannelsLoad>(ChannelsLoad.Loading) }
    var attempt by remember(templateId) { mutableIntStateOf(0) }

    LaunchedEffect(templateId, attempt) {
        if (templateId == null) return@LaunchedEffect
        state = ChannelsLoad.Loading
        state = when (val r = load(templateId)) {
            is WriteResult.Ok -> ChannelsLoad.Ready(r.value)
            is WriteResult.Err -> ChannelsLoad.Failed(r.message)
        }
    }

    Column(modifier = modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(20.dp)) {
        if (templateId == null) {
            WordingChannel.entries.forEach { channel ->
                ChannelSection(channel) {
                    NotSet(channelNotSetReason(channel, templateSaved = false, supported = false, notificationLabel = null))
                }
            }
            return@Column
        }
        when (val s = state) {
            ChannelsLoad.Loading -> Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                modifier = Modifier.semantics { contentDescription = CHANNEL_LOADING },
            ) {
                AuntieSpinner(modifier = Modifier.size(16.dp))
                Text("Loading…", style = AuntieTheme.typography.bodySmall, color = c.textDim)
            }
            is ChannelsLoad.Failed -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(s.message, style = AuntieTheme.typography.bodySmall, color = c.error)
                GhostButton(label = "Try again", onClick = { attempt += 1 })
            }
            is ChannelsLoad.Ready -> {
                val onSaved: (TemplateChannels) -> Unit = { state = ChannelsLoad.Ready(it) }
                TextMessageSection(templateId, s.channels, editable, save, onSaved)
                PushSection(templateId, s.channels, editable, save, onSaved)
            }
        }
    }
}

@Composable
private fun ChannelSection(channel: WordingChannel, content: @Composable () -> Unit) {
    Column(modifier = Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        TemplateChannelTitle(channel.title)
        content()
    }
}

@Composable
private fun NotSet(reason: String?, addLabel: String? = null, onAdd: (() -> Unit)? = null) {
    val c = AuntieTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(CHANNEL_NOT_SET, style = AuntieTheme.typography.bodyMedium, color = c.textDim)
        reason?.let { Text(it, style = AuntieTheme.typography.bodySmall, color = c.textDim) }
        if (addLabel != null && onAdd != null) GhostButton(label = addLabel, onClick = onAdd)
    }
}

/** One box of wording: the field, its count, and its own error directly under it. */
@Composable
private fun WordingField(
    label: String,
    value: TextFieldValue,
    onValueChange: (TextFieldValue) -> Unit,
    max: Int,
    error: String?,
    minLines: Int,
    onFocused: () -> Unit = {},
    /** A second line under the count: how many texts a text message sends as. */
    hint: String? = null,
) {
    val c = AuntieTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        MultilineFieldValue(
            value = value,
            onValueChange = onValueChange,
            label = label,
            minLines = minLines,
            modifier = Modifier.fillMaxWidth().onFocusChanged { if (it.hasFocus) onFocused() },
        )
        Text(
            wordingCounter(value.text, max),
            style = AuntieTheme.typography.bodySmall,
            color = if (max > 0 && value.text.trim().length > max) c.error else c.textDim,
        )
        hint?.let { Text(it, style = AuntieTheme.typography.bodySmall, color = c.textDim) }
        error?.let { Text(it, style = AuntieTheme.typography.bodySmall, color = c.error) }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun FieldChips(fields: List<String>, enabled: Boolean, onInsert: (String) -> Unit) {
    if (fields.isEmpty()) return
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        AuntieFieldLabel(text = "Fields you can use")
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            fields.forEach { name ->
                val token = "{{$name}}"
                // Not the mono chip: it draws its label in capitals, and a field
                // name is typed exactly as shown ({{Business}} is not {{business}}).
                AuntieChip(label = token, onClick = { onInsert(token) }, enabled = enabled, tone = AuntieChipTone.Teal)
            }
        }
    }
}

/** Drops [token] at the caret, replacing any selection, and parks the caret after it. */
private fun TextFieldValue.insert(token: String): TextFieldValue {
    val start = selection.min.coerceIn(0, text.length)
    val end = selection.max.coerceIn(start, text.length)
    return TextFieldValue(text.substring(0, start) + token + text.substring(end), TextRange(start + token.length))
}

@Composable
private fun SaveRow(channel: WordingChannel, saving: Boolean, error: String?, notice: String?, onSave: () -> Unit) {
    val c = AuntieTheme.colors
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        PrimaryButton(
            label = channel.saveLabel,
            onClick = onSave,
            enabled = !saving,
            loading = saving,
        )
        if (saving) Text("Saving…", style = AuntieTheme.typography.bodySmall, color = c.textDim)
        error?.let { Text(it, style = AuntieTheme.typography.bodySmall, color = c.error) }
        notice?.let { Text(it, style = AuntieTheme.typography.bodySmall, color = c.success) }
    }
}

@Composable
private fun ReadWording(label: String, value: String) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        AuntieFieldLabel(text = label)
        Text(value, style = AuntieTheme.typography.bodyMedium, color = AuntieTheme.colors.textPrimary)
    }
}

@Composable
private fun TextMessageSection(
    templateId: String,
    channels: TemplateChannels,
    editable: Boolean,
    save: suspend (String, String?, PushWording?) -> WriteResult<TemplateChannels>,
    onSaved: (TemplateChannels) -> Unit,
) {
    val channel = WordingChannel.TEXT
    val sms = channels.sms
    val scope = rememberReportingScope("templateChannelWording.text")
    // Keyed on what is stored, so a save (of either channel) that changes it
    // reloads the box, and a save that leaves it alone keeps what was typed.
    var draft by remember(templateId, sms.text) { mutableStateOf(TextFieldValue(sms.text)) }
    var adding by remember(templateId) { mutableStateOf(false) }
    var fieldError by remember(templateId) { mutableStateOf<String?>(null) }
    var saveError by remember(templateId) { mutableStateOf<String?>(null) }
    var notice by remember(templateId) { mutableStateOf<String?>(null) }
    var saving by remember(templateId) { mutableStateOf(false) }

    ChannelSection(channel) {
        val reason = channelNotSetReason(channel, templateSaved = true, supported = sms.supported, notificationLabel = channels.notificationLabel)
        when {
            reason != null -> NotSet(reason)
            !sms.set && !adding -> {
                if (editable) NotSet(null, channel.addLabel) { adding = true } else NotSet(null)
                notice?.let { Text(it, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.success) }
            }
            !editable -> ReadWording(CHANNEL_TEXT, sms.text)
            else -> {
                WordingField(
                    label = CHANNEL_TEXT,
                    value = draft,
                    // Held while a save is on its way: the saved copy replaces the
                    // box when it lands, and would wipe anything typed meanwhile.
                    onValueChange = { if (!saving) { draft = it; fieldError = null; saveError = null; notice = null } },
                    max = sms.maxLength,
                    error = fieldError,
                    minLines = 3,
                    hint = smsSegmentHint(draft.text),
                )
                FieldChips(channels.fields, enabled = !saving) { draft = draft.insert(it); fieldError = null; notice = null }
                SaveRow(channel, saving, saveError, notice) {
                    val local = wordingPrecheck(CHANNEL_TEXT, draft.text, sms.maxLength)
                    fieldError = local
                    saveError = null
                    notice = null
                    if (local != null) return@SaveRow
                    saving = true
                    scope.launch {
                        when (val r = save(templateId, draft.text, null)) {
                            is WriteResult.Ok -> {
                                notice = channel.savedNotice
                                draft = TextFieldValue(r.value.sms.text)
                                onSaved(r.value)
                            }
                            is WriteResult.Err -> {
                                val byField = wordingFieldErrors(r)
                                fieldError = byField[WORDING_FIELD_TEXT]
                                if (fieldError == null) saveError = r.message
                            }
                        }
                        saving = false
                    }
                }
            }
        }
    }
}

@Composable
private fun PushSection(
    templateId: String,
    channels: TemplateChannels,
    editable: Boolean,
    save: suspend (String, String?, PushWording?) -> WriteResult<TemplateChannels>,
    onSaved: (TemplateChannels) -> Unit,
) {
    val channel = WordingChannel.PUSH
    val push = channels.push
    val scope = rememberReportingScope("templateChannelWording.push")
    var title by remember(templateId, push.title) { mutableStateOf(TextFieldValue(push.title)) }
    var body by remember(templateId, push.body) { mutableStateOf(TextFieldValue(push.body)) }
    var adding by remember(templateId) { mutableStateOf(false) }
    var titleError by remember(templateId) { mutableStateOf<String?>(null) }
    var bodyError by remember(templateId) { mutableStateOf<String?>(null) }
    var saveError by remember(templateId) { mutableStateOf<String?>(null) }
    var notice by remember(templateId) { mutableStateOf<String?>(null) }
    var saving by remember(templateId) { mutableStateOf(false) }
    // A chip goes into whichever of the two boxes was last clicked into.
    var titleFocused by remember(templateId) { mutableStateOf(false) }

    ChannelSection(channel) {
        val reason = channelNotSetReason(channel, templateSaved = true, supported = push.supported, notificationLabel = channels.notificationLabel)
        // Half-written wording (a title and no message) is not "set" for the
        // sender, but it is there to read and finish, so it opens the form.
        val hasWording = push.set || push.title.isNotBlank() || push.body.isNotBlank()
        when {
            reason != null -> NotSet(reason)
            !hasWording && !adding -> {
                if (editable) NotSet(null, channel.addLabel) { adding = true } else NotSet(null)
                notice?.let { Text(it, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.success) }
            }
            !editable -> {
                ReadWording("Title", push.title)
                ReadWording("Message", push.body)
            }
            else -> {
                WordingField(
                    label = "Title",
                    value = title,
                    onValueChange = { if (!saving) { title = it; titleError = null; saveError = null; notice = null } },
                    max = push.titleMaxLength,
                    error = titleError,
                    minLines = 1,
                    onFocused = { titleFocused = true },
                )
                WordingField(
                    label = "Message",
                    value = body,
                    onValueChange = { if (!saving) { body = it; bodyError = null; saveError = null; notice = null } },
                    max = push.bodyMaxLength,
                    error = bodyError,
                    minLines = 2,
                    onFocused = { titleFocused = false },
                )
                FieldChips(channels.fields, enabled = !saving) {
                    if (titleFocused) { title = title.insert(it); titleError = null } else { body = body.insert(it); bodyError = null }
                    notice = null
                }
                SaveRow(channel, saving, saveError, notice) {
                    titleError = wordingPrecheck("Title", title.text, push.titleMaxLength)
                    bodyError = wordingPrecheck("Message", body.text, push.bodyMaxLength)
                    saveError = null
                    notice = null
                    if (titleError != null || bodyError != null) return@SaveRow
                    saving = true
                    scope.launch {
                        when (val r = save(templateId, null, PushWording(title.text, body.text))) {
                            is WriteResult.Ok -> {
                                notice = channel.savedNotice
                                title = TextFieldValue(r.value.push.title)
                                body = TextFieldValue(r.value.push.body)
                                onSaved(r.value)
                            }
                            is WriteResult.Err -> {
                                val byField = wordingFieldErrors(r)
                                titleError = byField[WORDING_FIELD_PUSH_TITLE]
                                bodyError = byField[WORDING_FIELD_PUSH_BODY]
                                if (titleError == null && bodyError == null) saveError = r.message
                            }
                        }
                        saving = false
                    }
                }
            }
        }
    }
}
