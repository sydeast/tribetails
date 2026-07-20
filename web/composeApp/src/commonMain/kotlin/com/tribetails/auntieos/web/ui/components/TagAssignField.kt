package com.tribetails.auntieos.web.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.web.data.TagDef
import com.tribetails.auntieos.web.data.normalizeTagName
import com.tribetails.auntieos.web.data.suggestTags
import com.tribetails.auntieos.web.theme.AuntieTheme

/**
 * TagAssignField: the assigned tags as removable chips, plus a text input that
 * autocompletes from the vocabulary and also accepts a free-form name. A port of
 * the React admin `src/components/TagAssignField.tsx`, whose pure transforms live
 * in `src/lib/tags/assign.ts`.
 *
 * Selecting a suggestion or pressing the field's action adds the tag; the chip
 * "x" removes it. A typed name that is not yet in the vocabulary can be promoted
 * to it ("Add ... to your tags"), which both assigns the name and hands it back
 * through [onCreateVocab] for the caller to persist.
 *
 * Pure logic stays in this file's top-level helpers and in TagModels.kt; the
 * composable below is the thin shell, the Den convention of keeping transforms
 * out of the view.
 *
 * THE CASING RULE, which is the whole reason [canonicalTagName] exists: every
 * name COMPARISON is case-insensitive on the normalized name, but what gets
 * STORED is the vocabulary's own casing on a hit. Type "vip" against a "VIP"
 * entry and the assignment reads "VIP". Storing the typed casing instead is how a
 * profile ends up with two tags that look identical to a human.
 */

// ---- pure helpers ----
//
// addAssigned / removeAssigned port the other half of the React `assign.ts`
// module (suggestTags, the third helper there, already lives in TagModels.kt
// beside the vocabulary transforms it shares a comparison rule with). They sit
// here because assignment is this field's job, not the vocabulary model's.

/** The comparison key for a tag name: normalized, then lowercased. */
private fun nameKey(name: String): String = normalizeTagName(name).lowercase()

/**
 * The name to actually assign for a typed [name]: the vocabulary entry's casing
 * when one matches case-insensitively, otherwise the typed name normalized.
 */
fun canonicalTagName(name: String, vocab: List<TagDef>): String {
    val hit = vocab.firstOrNull { nameKey(it.name) == nameKey(name) }
    return hit?.name ?: normalizeTagName(name)
}

/** True when [name] already has a vocabulary entry (case-insensitive, normalized). */
fun tagInVocabulary(name: String, vocab: List<TagDef>): Boolean =
    normalizeTagName(name) != "" && vocab.any { nameKey(it.name) == nameKey(name) }

/**
 * True when the "add to your tags" affordance should be offered: the caller
 * supports promotion ([canPromote]), the draft is not blank, and the name is not
 * already a vocabulary entry. Offering it for an existing name would walk the
 * operator straight into addTag's duplicate error.
 */
fun canCreateTagVocab(draft: String, vocab: List<TagDef>, canPromote: Boolean): Boolean =
    canPromote && normalizeTagName(draft) != "" && !tagInVocabulary(draft, vocab)

/** Copy for the promotion affordance. */
fun tagCreateAffordanceLabel(name: String): String = "Add \"$name\" to your tags"

/** True when the suggestion list should be visible: focused, with something in it. */
fun showTagSuggestions(focused: Boolean, suggestionCount: Int, canCreate: Boolean): Boolean =
    focused && (suggestionCount > 0 || canCreate)

/**
 * Add a tag name to the assigned list: normalized, and deduped case-insensitively
 * (so "vip" is not added beside an existing "VIP"). A blank name is a no-op.
 * Appends at the END, preserving order. Returns a new list; never mutates.
 */
fun addAssigned(already: List<String>, name: String): List<String> {
    val n = normalizeTagName(name)
    if (n == "") return already
    if (already.any { nameKey(it) == nameKey(n) }) return already
    return already + n
}

/**
 * Remove a tag name from the assigned list (case-insensitive), preserving the
 * order of what is left. Removing the last tag genuinely yields an empty list, so
 * the caller's write actually clears the field. Returns a new list.
 */
fun removeAssigned(already: List<String>, name: String): List<String> {
    val k = nameKey(name)
    return already.filterNot { nameKey(it) == k }
}

// ---- the Compose shell ----

/**
 * @param value         the assigned tag NAMES.
 * @param vocab         the relevant vocabulary, for autocomplete and chip resolution.
 * @param onChange      called with the next name list on every add / remove.
 * @param onCreateVocab when supplied, a typed name absent from [vocab] can be
 *                      promoted to it. Selecting the affordance BOTH assigns the
 *                      name (through [onChange]) and calls this so the caller can
 *                      persist it. Omit to allow free-form assignment without
 *                      growing the vocabulary.
 * @param inputLabel    accessible label for the text input.
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

    val suggestions = suggestTags(draft, vocab, value)
    val trimmed = normalizeTagName(draft)
    val canCreate = canCreateTagVocab(draft, vocab, canPromote = onCreateVocab != null)
    val showList = showTagSuggestions(focused, suggestions.size, canCreate)

    fun assign(name: String) {
        onChange(addAssigned(value, canonicalTagName(name, vocab)))
        draft = ""
    }

    fun create() {
        val promote = onCreateVocab ?: return
        if (!canCreate) return
        promote(trimmed)
        onChange(addAssigned(value, trimmed))
        draft = ""
    }

    // One focus scope around BOTH the field and the list. `hasFocus` stays true
    // while focus moves from the input to a suggestion row, so the list survives
    // long enough for the tap to land. React needs a blur timer for this; Compose
    // gives it to us for free.
    Column(
        modifier = modifier.onFocusChanged { focused = it.hasFocus },
        verticalArrangement = Arrangement.spacedBy(dims.space2),
    ) {
        if (value.isNotEmpty()) {
            FlowRow(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(dims.space2),
                verticalArrangement = Arrangement.spacedBy(dims.space2),
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

        BottomBorderField(
            value = draft,
            onValueChange = { draft = it },
            label = inputLabel,
            placeholder = "Type or pick a tag",
            enabled = enabled,
            imeAction = ImeAction.Done,
            onImeAction = { if (trimmed != "") assign(trimmed) },
            modifier = Modifier.fillMaxWidth(),
        )

        if (showList) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = 220.dp)
                    .clip(RoundedCornerShape(12.dp))
                    .background(c.surface2)
                    .border(
                        BorderStroke(dims.borderHairline, SolidColor(c.border)),
                        RoundedCornerShape(12.dp),
                    )
                    .verticalScroll(rememberScrollState()),
            ) {
                suggestions.forEach { tag ->
                    SuggestionRow(onClick = { assign(tag.name) }) {
                        if (tagChipShowsIcon(tag.icon)) {
                            Text(text = tag.icon, style = AuntieTheme.typography.labelLarge)
                        }
                        Text(
                            text = tag.name,
                            style = AuntieTheme.typography.labelLarge,
                            color = c.textPrimary,
                        )
                    }
                }
                if (canCreate) {
                    SuggestionRow(onClick = { create() }) {
                        Text(
                            text = tagCreateAffordanceLabel(trimmed),
                            style = AuntieTheme.typography.labelLarge,
                            color = c.primary,
                        )
                    }
                }
            }
        }
    }
}

/** One tappable row in the inline suggestion list. */
@Composable
private fun SuggestionRow(
    onClick: () -> Unit,
    content: @Composable () -> Unit,
) {
    val dims = AuntieTheme.dims
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = dims.space3, vertical = dims.space2),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(dims.space2),
    ) {
        content()
    }
}
