package com.tribetails.auntieos.ui.admin

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.data.repository.PushWording
import com.tribetails.auntieos.data.repository.TemplateChannels
import com.tribetails.auntieos.data.repository.WORDING_FIELD_PUSH_BODY
import com.tribetails.auntieos.data.repository.WORDING_FIELD_PUSH_TITLE
import com.tribetails.auntieos.data.repository.WORDING_FIELD_SMS_TEXT
import com.tribetails.auntieos.data.repository.wordingFieldErrorsOf
import com.tribetails.auntieos.ui.components.AuntieChip
import com.tribetails.auntieos.ui.components.AuntieField
import com.tribetails.auntieos.ui.components.AuntieFieldLabel
import com.tribetails.auntieos.ui.components.GhostButton
import com.tribetails.auntieos.ui.components.GlassSurface
import com.tribetails.auntieos.ui.components.LoadingHint
import com.tribetails.auntieos.ui.components.PrimaryButton
import com.tribetails.auntieos.ui.theme.AuntieTheme
import kotlinx.coroutines.launch

/**
 * #1935: the text-message and push wording of a template, beside its email.
 *
 * Both template editors and the read-only viewer draw this one composable, so
 * the three channels read the same wherever a template is opened. The email
 * editor above it is untouched: each channel here loads and saves on its own,
 * through `getTemplateChannels` / `saveTemplateChannels`, and a refusal on one
 * never holds the other back.
 *
 * Every rule that matters lives on the server. This screen only stops a blank
 * or over-long field before the round trip, with the server's own sentences,
 * and reads the limits off the answer rather than carrying its own.
 */

/** The names the three channels go by on screen. */
internal const val CHANNEL_EMAIL = "Email"
internal const val CHANNEL_TEXT = "Text message"
internal const val CHANNEL_PUSH = "Push notification"

internal const val CHANNEL_NOT_SET = "Not set"
internal const val CHANNEL_SAVE_FIRST = "Save this template first."
internal const val CHANNEL_LOADING = "Loading…"
internal const val CHANNEL_LOAD_FAILED = "Couldn't load this template's text message and push notification."
internal const val CHANNEL_SAVE_FAILED = "Couldn't save. Try again."

internal const val TEXT_SECTION_TAG = "channel-text"
internal const val PUSH_SECTION_TAG = "channel-push"
internal const val TEXT_FIELD_TAG = "channel-text-field"
internal const val PUSH_TITLE_FIELD_TAG = "channel-push-title-field"
internal const val PUSH_BODY_FIELD_TAG = "channel-push-body-field"
internal const val TEXT_SAVE_TAG = "channel-text-save"
internal const val PUSH_SAVE_TAG = "channel-push-save"
internal const val CHANNEL_LOADING_TAG = "channel-loading"
internal const val TEXT_SEGMENTS_TAG = "channel-text-segments"

/** Which of the two channels a sentence is about. */
internal enum class WordingChannel(
    val title: String,
    val add: String,
    val save: String,
    val saved: String,
    private val noTemplate: String,
    private val notSent: String,
) {
    TEXT(
        title = CHANNEL_TEXT,
        add = "Add text message",
        save = "Save text message",
        saved = "Text message saved.",
        noTemplate = "No notification sends this template, so it has no text message.",
        notSent = "This notification is not sent by text message.",
    ),
    PUSH(
        title = CHANNEL_PUSH,
        add = "Add push notification",
        save = "Save push notification",
        saved = "Push notification saved.",
        noTemplate = "No notification sends this template, so it has no push notification.",
        notSent = "This notification is not sent as a push notification.",
    );

    /** Why this channel has no wording and cannot be given any. */
    fun unsupportedMessage(notificationLabel: String?): String =
        if (notificationLabel == null) noTemplate else notSent
}

/**
 * The sentence under "Not set", or null when the channel can be added (the
 * Add button stands in its place) or already has wording.
 *
 * [saved] is false for a template that has not been saved yet: nothing is
 * asked of the server then, so the only honest thing to say is to save first.
 */
internal fun channelNotSetMessage(
    channel: WordingChannel,
    saved: Boolean,
    supported: Boolean,
    notificationLabel: String?,
): String? = when {
    !saved -> CHANNEL_SAVE_FIRST
    !supported -> channel.unsupportedMessage(notificationLabel)
    else -> null
}

/**
 * The two things worth refusing before the round trip, in the server's exact
 * words: blank, and over the limit the server sent. [label] is the field's
 * name on screen. Length is counted trimmed, as the server counts it.
 */
internal fun wordingPrecheck(label: String, value: String, max: Int): String? {
    val length = value.trim().length
    return when {
        length == 0 -> "$label cannot be empty."
        max > 0 && length > max -> "$label is $length characters. The limit is $max."
        else -> null
    }
}

/** "12 of 1600 characters", counted the way the server counts. */
internal fun wordingCounter(value: String, max: Int): String = "${value.trim().length} of $max characters"

/** The GSM-7 alphabet: 160 to a text. The extension set takes two places each. */
private const val GSM7_BASIC =
    "@£\$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
        "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"
private const val GSM7_EXTENDED = "^{}\\[~]|€\u000C"

/** How many texts a message goes out as, and whether a special character shortened each one. */
internal data class SmsSegments(val segments: Int, val unicode: Boolean)

/**
 * The same count as the web editor's `smsSegments`: 160 places in one text or
 * 153 each when split, 70 or 67 (UTF-16 units) once any character is outside
 * the plain alphabet. Counted on the trimmed wording as typed.
 */
internal fun smsSegments(text: String): SmsSegments {
    val value = text.trim()
    if (value.isEmpty()) return SmsSegments(0, false)
    var places = 0
    var i = 0
    while (i < value.length) {
        val cp = value.codePointAt(i)
        val ch = String(Character.toChars(cp))
        when {
            GSM7_BASIC.contains(ch) -> places += 1
            GSM7_EXTENDED.contains(ch) -> places += 2
            else -> {
                val units = value.length
                return SmsSegments(if (units <= 70) 1 else (units + 66) / 67, true)
            }
        }
        i += Character.charCount(cp)
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

/** Half-written push wording is not "set" for the sender, but it is there to read and finish. */
internal fun pushHasWording(push: com.tribetails.auntieos.data.repository.PushChannel): Boolean =
    push.set || push.title.isNotBlank() || push.body.isNotBlank()

/** A field dropped onto the end of what is typed, with one space before it when needed. */
internal fun appendField(value: String, field: String): String {
    val token = "{{$field}}"
    return if (value.isEmpty() || value.last().isWhitespace()) value + token else "$value $token"
}

private sealed interface ChannelLoad {
    data object Loading : ChannelLoad
    data class Failed(val message: String) : ChannelLoad
    data class Ready(val channels: TemplateChannels) : ChannelLoad
}

/**
 * @param templateId the stored template, or null for one not saved yet (no call is made).
 * @param readOnly the viewer's mode: wording is shown, nothing can be added or saved.
 */
@Composable
internal fun TemplateChannelWording(
    templateId: String?,
    load: suspend (String) -> Result<TemplateChannels>,
    save: suspend (templateId: String, smsText: String?, push: PushWording?) -> Result<TemplateChannels>,
    modifier: Modifier = Modifier,
    readOnly: Boolean = false,
) {
    var state by remember(templateId) { mutableStateOf<ChannelLoad>(ChannelLoad.Loading) }
    var attempt by remember(templateId) { mutableIntStateOf(0) }
    LaunchedEffect(templateId, attempt) {
        if (templateId == null) return@LaunchedEffect
        state = ChannelLoad.Loading
        state = load(templateId).fold(
            onSuccess = { ChannelLoad.Ready(it) },
            onFailure = { ChannelLoad.Failed(it.message?.takeIf { m -> m.isNotBlank() } ?: CHANNEL_LOAD_FAILED) },
        )
    }

    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(20.dp)) {
        val current = state
        when {
            templateId == null -> {
                NotSetCard(WordingChannel.TEXT, TEXT_SECTION_TAG, CHANNEL_SAVE_FIRST)
                NotSetCard(WordingChannel.PUSH, PUSH_SECTION_TAG, CHANNEL_SAVE_FIRST)
            }
            current is ChannelLoad.Loading -> {
                ChannelCard(WordingChannel.TEXT, TEXT_SECTION_TAG) {
                    Column(Modifier.testTag(CHANNEL_LOADING_TAG)) { LoadingHint(CHANNEL_LOADING) }
                }
                ChannelCard(WordingChannel.PUSH, PUSH_SECTION_TAG) { LoadingHint(CHANNEL_LOADING) }
            }
            current is ChannelLoad.Failed -> {
                GlassSurface(cornerRadius = 18.dp, modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text(
                            "$CHANNEL_TEXT and ${CHANNEL_PUSH.lowercase()}",
                            style = AuntieTheme.typography.titleSmall,
                            color = AuntieTheme.colors.textPrimary,
                        )
                        Text(current.message, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.error)
                        GhostButton(label = "Try again", onClick = { attempt++ })
                    }
                }
            }
            current is ChannelLoad.Ready -> {
                val channels = current.channels
                TextMessageCard(
                    channels = channels,
                    readOnly = readOnly,
                    save = { text -> save(templateId, text, null) },
                    onSaved = { state = ChannelLoad.Ready(it) },
                )
                PushCard(
                    channels = channels,
                    readOnly = readOnly,
                    save = { wording -> save(templateId, null, wording) },
                    onSaved = { state = ChannelLoad.Ready(it) },
                )
            }
        }
    }
}

@Composable
private fun ChannelCard(channel: WordingChannel, tag: String, content: @Composable () -> Unit) {
    GlassSurface(cornerRadius = 18.dp, modifier = Modifier.fillMaxWidth().testTag(tag)) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(channel.title, style = AuntieTheme.typography.titleSmall, color = AuntieTheme.colors.textPrimary)
            content()
        }
    }
}

@Composable
private fun NotSetCard(
    channel: WordingChannel,
    tag: String,
    message: String?,
    onAdd: (() -> Unit)? = null,
) {
    val c = AuntieTheme.colors
    ChannelCard(channel, tag) {
        Text(CHANNEL_NOT_SET, style = AuntieTheme.typography.bodyMedium, color = c.textDim)
        message?.let { Text(it, style = AuntieTheme.typography.bodySmall, color = c.textDim) }
        onAdd?.let { GhostButton(label = channel.add, onClick = it) }
    }
}

@Composable
private fun WordingField(
    label: String,
    value: String,
    max: Int,
    error: String?,
    enabled: Boolean,
    singleLine: Boolean,
    tag: String,
    onFocused: () -> Unit = {},
    /** A second line under the count: how many texts a text message sends as. */
    hint: String? = null,
    onChange: (String) -> Unit,
) {
    val c = AuntieTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        AuntieFieldLabel(text = label, required = true)
        AuntieField(
            value = value,
            onValueChange = onChange,
            enabled = enabled,
            singleLine = singleLine,
            minLines = if (singleLine) 1 else 3,
            isError = error != null,
            modifier = Modifier.fillMaxWidth(),
            fieldModifier = Modifier.testTag(tag).onFocusChanged { if (it.isFocused) onFocused() },
        )
        error?.let { Text(it, style = AuntieTheme.typography.bodySmall, color = c.error) }
        Text(wordingCounter(value, max), style = AuntieTheme.typography.labelSmall, color = c.textFaint)
        hint?.let {
            Text(it, style = AuntieTheme.typography.labelSmall, color = c.textFaint, modifier = Modifier.testTag(TEXT_SEGMENTS_TAG))
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun FieldChips(fields: List<String>, enabled: Boolean, onInsert: (String) -> Unit) {
    if (fields.isEmpty()) return
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        AuntieFieldLabel(text = "Fields you can use")
        FlowRow(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            fields.forEach { field ->
                AuntieChip(selected = false, onClick = { onInsert(field) }, label = "{{$field}}", enabled = enabled)
            }
        }
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
private fun SaveRow(
    channel: WordingChannel,
    tag: String,
    saving: Boolean,
    failure: String?,
    notice: String?,
    onSave: () -> Unit,
) {
    val c = AuntieTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        PrimaryButton(
            label = channel.save,
            onClick = onSave,
            enabled = !saving,
            loading = saving,
            modifier = Modifier.testTag(tag),
        )
        // The button's own spinner replaces its label, so the wait is named here.
        if (saving) LoadingHint("Saving…")
        failure?.let { Text(it, style = AuntieTheme.typography.bodySmall, color = c.error) }
        notice?.let { Text(it, style = AuntieTheme.typography.bodySmall, color = c.textDim) }
    }
}

@Composable
private fun TextMessageCard(
    channels: TemplateChannels,
    readOnly: Boolean,
    save: suspend (String) -> Result<TemplateChannels>,
    onSaved: (TemplateChannels) -> Unit,
) {
    val channel = WordingChannel.TEXT
    val sms = channels.sms
    val scope = rememberCoroutineScope()
    // Saveable, like the email editor above (#953): a rotation rebuilds the
    // Activity, and what was typed here has to come back with it.
    var adding by rememberSaveable { mutableStateOf(false) }
    var text by rememberSaveable(sms.text) { mutableStateOf(sms.text) }
    var error by remember { mutableStateOf<String?>(null) }
    var failure by remember { mutableStateOf<String?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }

    if (!sms.supported || (!sms.set && (readOnly || !adding))) {
        NotSetCard(
            channel,
            TEXT_SECTION_TAG,
            channelNotSetMessage(channel, saved = true, supported = sms.supported, channels.notificationLabel),
            onAdd = if (sms.supported && !readOnly) ({ adding = true }) else null,
        )
        return
    }
    ChannelCard(channel, TEXT_SECTION_TAG) {
        if (readOnly) {
            ReadWording(CHANNEL_TEXT, sms.text)
            return@ChannelCard
        }
        WordingField(
            label = CHANNEL_TEXT,
            value = text,
            max = sms.maxLength,
            error = error,
            enabled = !saving,
            singleLine = false,
            tag = TEXT_FIELD_TAG,
            hint = smsSegmentHint(text),
        ) { text = it; error = null; failure = null; notice = null }
        FieldChips(channels.fields, enabled = !saving) { text = appendField(text, it); error = null }
        SaveRow(channel, TEXT_SAVE_TAG, saving, failure, notice) {
            notice = null
            failure = null
            error = wordingPrecheck(CHANNEL_TEXT, text, sms.maxLength)
            if (error != null) return@SaveRow
            saving = true
            scope.launch {
                save(text)
                    .onSuccess { notice = channel.saved; onSaved(it) }
                    .onFailure { t ->
                        val fieldErrors = wordingFieldErrorsOf(t)
                        error = fieldErrors[WORDING_FIELD_SMS_TEXT]
                        if (error == null) failure = t.message?.takeIf { it.isNotBlank() } ?: CHANNEL_SAVE_FAILED
                    }
                saving = false
            }
        }
    }
}

@Composable
private fun PushCard(
    channels: TemplateChannels,
    readOnly: Boolean,
    save: suspend (PushWording) -> Result<TemplateChannels>,
    onSaved: (TemplateChannels) -> Unit,
) {
    val channel = WordingChannel.PUSH
    val push = channels.push
    val scope = rememberCoroutineScope()
    var adding by rememberSaveable { mutableStateOf(false) }
    var title by rememberSaveable(push.title) { mutableStateOf(push.title) }
    var body by rememberSaveable(push.body) { mutableStateOf(push.body) }
    var titleError by remember { mutableStateOf<String?>(null) }
    var bodyError by remember { mutableStateOf<String?>(null) }
    var failure by remember { mutableStateOf<String?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }
    // A field chip goes into whichever of the two was touched last.
    var titleFocused by remember { mutableStateOf(false) }

    if (!push.supported || (!pushHasWording(push) && (readOnly || !adding))) {
        NotSetCard(
            channel,
            PUSH_SECTION_TAG,
            channelNotSetMessage(channel, saved = true, supported = push.supported, channels.notificationLabel),
            onAdd = if (push.supported && !readOnly) ({ adding = true }) else null,
        )
        return
    }
    ChannelCard(channel, PUSH_SECTION_TAG) {
        if (readOnly) {
            ReadWording("Title", push.title)
            ReadWording("Message", push.body)
            return@ChannelCard
        }
        WordingField(
            label = "Title",
            value = title,
            max = push.titleMaxLength,
            error = titleError,
            enabled = !saving,
            singleLine = true,
            tag = PUSH_TITLE_FIELD_TAG,
            onFocused = { titleFocused = true },
        ) { title = it; titleError = null; failure = null; notice = null }
        WordingField(
            label = "Message",
            value = body,
            max = push.bodyMaxLength,
            error = bodyError,
            enabled = !saving,
            singleLine = false,
            tag = PUSH_BODY_FIELD_TAG,
            onFocused = { titleFocused = false },
        ) { body = it; bodyError = null; failure = null; notice = null }
        FieldChips(channels.fields, enabled = !saving) {
            if (titleFocused) { title = appendField(title, it); titleError = null } else { body = appendField(body, it); bodyError = null }
        }
        SaveRow(channel, PUSH_SAVE_TAG, saving, failure, notice) {
            notice = null
            failure = null
            titleError = wordingPrecheck("Title", title, push.titleMaxLength)
            bodyError = wordingPrecheck("Message", body, push.bodyMaxLength)
            if (titleError != null || bodyError != null) return@SaveRow
            saving = true
            scope.launch {
                save(PushWording(title, body))
                    .onSuccess { notice = channel.saved; onSaved(it) }
                    .onFailure { t ->
                        val fieldErrors = wordingFieldErrorsOf(t)
                        titleError = fieldErrors[WORDING_FIELD_PUSH_TITLE]
                        bodyError = fieldErrors[WORDING_FIELD_PUSH_BODY]
                        if (titleError == null && bodyError == null) {
                            failure = t.message?.takeIf { it.isNotBlank() } ?: CHANNEL_SAVE_FAILED
                        }
                    }
                saving = false
            }
        }
    }
}
