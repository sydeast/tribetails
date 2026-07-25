package com.tribetails.auntieos.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.data.model.TagDef
import com.tribetails.auntieos.data.model.addAssigned
import com.tribetails.auntieos.data.model.canonicalTagName
import com.tribetails.auntieos.data.model.normalizeTagName
import com.tribetails.auntieos.data.model.removeAssigned
import com.tribetails.auntieos.data.model.suggestTags
import com.tribetails.auntieos.ui.theme.AuntieTheme
import kotlinx.coroutines.delay

/**
 * Hybrid tag assign field: the current tags as removable chips, plus a text
 * input that autocompletes from the vocabulary and also accepts a free-form
 * name. Ported from the React admin
 * (auntieos-admin src/components/TagAssignField.tsx + src/lib/tags/assign.ts);
 * the android tree shares no code with commonMain, so this is an independent
 * port written from that source, pinned by TagAssignFieldTest.kt.
 *
 * All of the transforms live in the pure helpers below and in
 * data/model/TagModels.kt, so the composable stays a thin shell, the Den
 * convention.
 */

// ── pure helpers ─────────────────────────────────────────────────────────────

/** What the field offers for the current draft: suggestions plus the create affordance. */
data class TagAssignState(
    /** Vocabulary matches, unassigned, prefix hits first then substring hits. */
    val suggestions: List<TagDef>,
    /** The draft with whitespace normalized. Casing is left alone. */
    val trimmed: String,
    /** True when the draft is a genuinely new name and the caller accepts new vocabulary. */
    val canCreate: Boolean,
    /** The create affordance copy. Only meaningful while [canCreate]. */
    val createLabel: String,
)

/**
 * Case-insensitive vocabulary lookup on the normalized name, the rule the whole
 * tag layer shares. Written here rather than reaching into TagModels' private
 * `sameName` so this file states the rule it depends on out loud.
 */
private fun vocabHit(name: String, vocab: List<TagDef>): TagDef? =
    vocab.firstOrNull { normalizeTagName(it.name).equals(normalizeTagName(name), ignoreCase = true) }

/** The create affordance copy, matching the React button verbatim. */
fun tagCreateLabel(name: String): String = "Add \"$name\" to your tags"

/**
 * Derive everything the field offers from the draft, the vocabulary and the
 * already-assigned names. [allowCreate] is the caller having supplied an
 * `onCreateVocab` handler: without one, a typed name can still be assigned
 * free-form, it just never grows the managed vocabulary.
 */
fun tagAssignState(
    draft: String,
    vocab: List<TagDef>,
    value: List<String>,
    allowCreate: Boolean,
): TagAssignState {
    val trimmed = normalizeTagName(draft)
    val canCreate = allowCreate && trimmed != "" && vocabHit(trimmed, vocab) == null
    return TagAssignState(
        suggestions = suggestTags(draft, vocab, value),
        trimmed = trimmed,
        canCreate = canCreate,
        createLabel = tagCreateLabel(trimmed),
    )
}

/**
 * How long the suggestion list outlives the field losing focus. Long enough for
 * the tap that stole the focus to reach a suggestion row, short enough that the
 * list is gone by the time the operator looks back. Matches the React field.
 */
const val TAG_SUGGEST_CLOSE_DELAY_MS = 150L

/** The list is worth showing only while the field is active and it has something in it. */
fun shouldShowSuggestionList(focused: Boolean, state: TagAssignState): Boolean =
    focused && (state.suggestions.isNotEmpty() || state.canCreate)

/**
 * Assign a name, preferring the vocabulary's canonical casing so picking "vip"
 * against a "VIP" entry stores "VIP". A blank name is a no-op and a duplicate is
 * deduped case-insensitively, both inside [addAssigned].
 */
fun tagAssignAdd(value: List<String>, vocab: List<TagDef>, name: String): List<String> =
    addAssigned(value, canonicalTagName(name, vocab))

// ── composable ───────────────────────────────────────────────────────────────

/**
 * @param value    The assigned tag NAMES.
 * @param vocab    The relevant vocabulary (household or pet) for autocomplete
 *                 and chip resolution.
 * @param onChange Called with the next name list on every add and remove.
 * @param onCreateVocab Optional. When given, a typed name that is not already in
 *                 the vocabulary shows an "add to your tags" affordance;
 *                 choosing it BOTH assigns the name (via [onChange]) and hands
 *                 the name back here so the caller can persist it to the managed
 *                 vocabulary. Omit to allow free-form assignment without growing
 *                 the vocabulary.
 * @param enabled  False while a save is in flight.
 * @param inputLabel Accessible label for the text input.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun TagAssignField(
    value: List<String>,
    vocab: List<TagDef>,
    onChange: (List<String>) -> Unit,
    modifier: Modifier = Modifier,
    onCreateVocab: ((String) -> Unit)? = null,
    enabled: Boolean = true,
    inputLabel: String = "Add a tag",
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims

    var draft by remember { mutableStateOf("") }
    var focused by remember { mutableStateOf(false) }
    // The android analogue of React's delayed-blur flag. The list closes on a
    // selection, and otherwise shortly after focus leaves, see the effect below.
    var listOpen by remember { mutableStateOf(false) }

    // Focus can leave with a draft still typed: the operator taps another field
    // or dismisses the keyboard. Closing only on an empty draft left the list
    // sitting open over the form, and nothing else dismisses it, since this list
    // is an inline column rather than a popup. Close on any focus loss, but not
    // instantly: a suggestion row is clickable and therefore focusable, so an
    // immediate close would race the very tap that moved the focus. The effect
    // is cancelled if focus comes back or the field leaves composition, the
    // structured-concurrency counterpart of the React field's cleared timer.
    LaunchedEffect(focused) {
        if (!focused) {
            delay(TAG_SUGGEST_CLOSE_DELAY_MS)
            listOpen = false
        }
    }

    val state = tagAssignState(
        draft = draft,
        vocab = vocab,
        value = value,
        allowCreate = onCreateVocab != null,
    )
    val showList = enabled && shouldShowSuggestionList(listOpen, state)

    fun assign(name: String) {
        onChange(tagAssignAdd(value, vocab, name))
        draft = ""
        listOpen = false
    }

    fun create() {
        val handler = onCreateVocab ?: return
        if (!state.canCreate) return
        handler(state.trimmed)
        // The typed name is not in the vocabulary, so there is no canonical
        // casing to prefer: store it exactly as typed (normalized).
        onChange(addAssigned(value, state.trimmed))
        draft = ""
        listOpen = false
    }

    val borderColor = animateColorAsState(
        if (focused) c.kinfolkOrange else c.border,
        label = "tagAssignBorder",
    ).value

    Column(modifier = modifier.alpha(if (enabled) 1f else 0.6f)) {
        if (value.isNotEmpty()) {
            FlowRow(
                modifier = Modifier.fillMaxWidth().padding(bottom = 10.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                value.forEach { name ->
                    TagChip(
                        name = name,
                        vocab = vocab,
                        onRemove = if (enabled) {
                            { onChange(removeAssigned(value, name)) }
                        } else {
                            null
                        },
                    )
                }
            }
        }

        AuntieFieldLabel(text = inputLabel)
        Spacer(Modifier.height(6.dp))

        // The Den bottom-border input, matching BottomBorderField. Built here
        // rather than reused because this field needs the IME "done" action to
        // assign the typed name, which that primitive does not expose.
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(36.dp)
                .drawBehind {
                    val y = size.height - 0.5.dp.toPx()
                    drawLine(
                        color = borderColor,
                        start = Offset(0f, y),
                        end = Offset(size.width, y),
                        strokeWidth = if (focused) 2.0.dp.toPx() else 1.5.dp.toPx(),
                    )
                }
                .padding(vertical = 8.dp),
            contentAlignment = Alignment.TopStart,
        ) {
            BasicTextField(
                value = draft,
                onValueChange = {
                    draft = it
                    listOpen = true
                },
                enabled = enabled,
                singleLine = true,
                cursorBrush = SolidColor(c.kinfolkOrange),
                textStyle = AuntieTheme.typography.bodyMedium.copy(color = c.textPrimary),
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Text,
                    imeAction = ImeAction.Done,
                ),
                keyboardActions = KeyboardActions(
                    onDone = { if (state.trimmed != "") assign(state.trimmed) },
                ),
                modifier = Modifier
                    .fillMaxWidth()
                    .semantics { contentDescription = inputLabel }
                    .onFocusChanged {
                        focused = it.isFocused
                        // The close on focus loss is the delayed one above.
                        if (it.isFocused) listOpen = true
                    },
                decorationBox = { inner ->
                    Box(contentAlignment = Alignment.CenterStart) {
                        if (draft.isEmpty()) {
                            Text(
                                text = "Type or pick a tag",
                                style = AuntieTheme.typography.bodyMedium,
                                color = c.textFaint,
                            )
                        }
                        inner()
                    }
                },
            )
        }

        if (showList) {
            val shape = RoundedCornerShape(12.dp)
            Spacer(Modifier.height(8.dp))
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(shape)
                    .background(c.surface2)
                    .border(dims.borderHairline, SolidColor(c.border), shape)
                    .padding(vertical = 4.dp),
            ) {
                state.suggestions.forEach { tag ->
                    SuggestionRow(
                        icon = tag.icon.takeIf { it.isNotEmpty() },
                        label = tag.name,
                        onClick = { assign(tag.name) },
                    )
                }
                if (state.canCreate) {
                    SuggestionRow(
                        icon = null,
                        label = state.createLabel,
                        onClick = { create() },
                        emphasis = true,
                    )
                }
            }
        }
    }
}

/** One row of the suggestion list. [emphasis] paints the create affordance in brand. */
@Composable
private fun SuggestionRow(
    icon: String?,
    label: String,
    onClick: () -> Unit,
    emphasis: Boolean = false,
) {
    val c = AuntieTheme.colors
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (icon != null) {
            Text(text = icon, style = AuntieTheme.typography.bodySmall)
        }
        Text(
            text = label,
            style = AuntieTheme.typography.bodyMedium,
            color = if (emphasis) c.primary else c.textPrimary,
        )
    }
}
