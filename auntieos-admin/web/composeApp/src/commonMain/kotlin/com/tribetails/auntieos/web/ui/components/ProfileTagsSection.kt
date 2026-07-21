package com.tribetails.auntieos.web.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import com.tribetails.auntieos.web.data.BusinessSettings
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.TagDef
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.data.DEFAULT_TAG_COLOR
import com.tribetails.auntieos.web.data.addTag
import com.tribetails.auntieos.web.theme.AuntieTheme
import kotlinx.coroutines.launch

/**
 * ProfileTagsSection: the "Tags" panel shared by the kinfolk profile (household
 * tags) and the kin profile (pet tags). A port of the React admin
 * `src/components/ProfileTagsSection.tsx`.
 *
 * It loads the scope-appropriate vocabulary from `business_settings` for
 * autocomplete and rich chip resolution, then saves each add / remove the moment
 * it happens, optimistically.
 *
 * THE FAIL-LOUD RULE THIS PANEL EXISTS TO HOLD: an optimistic save that fails
 * puts the chip back AND says why. A bare revert is the worst outcome available
 * here, because the operator taps a tag, watches it appear, watches it vanish,
 * and is told nothing, so they conclude the tag saved. Every failure transition
 * in [ProfileTagsState] therefore sets an error alongside the revert, and
 * ProfileTagsSectionTest asserts both halves on every one of them.
 *
 * A typed name not yet in the vocabulary can be promoted to it inline: that
 * assigns the name AND appends a default-colored [TagDef] to the right
 * vocabulary, so it becomes a reusable suggestion (recolorable later in the Tags
 * settings panel). The two writes are independent, and so are their failures.
 *
 * The state machine is pure and lives below; the composable is the thin shell
 * that runs the two writes and feeds their results back in.
 */

/**
 * Which vocabulary a tag belongs to. [wire] is the persisted / cross-surface
 * value and is the lowercase React literal, not the Kotlin constant name.
 */
enum class TagScope(val wire: String) {
    /** Household tags, stored on `kinfolk` docs and drawn from `householdTags`. */
    HOUSEHOLD("household"),

    /** Pet tags, stored on `kin` docs and drawn from `petTags`. */
    PET("pet"),
}

/** Panel subtitle for a scope. */
fun tagScopeSubtitle(scope: TagScope): String = when (scope) {
    TagScope.HOUSEHOLD -> "Labels on this household. Broadcasts and KinTale rules can target them."
    TagScope.PET -> "Labels on this pet, e.g. Reactive or On meds."
}

/** Accessible label for the scope's assign input. */
fun tagScopeInputLabel(scope: TagScope): String = when (scope) {
    TagScope.HOUSEHOLD -> "Add a household tag"
    TagScope.PET -> "Add a pet tag"
}

/**
 * The fallback used when a failure arrives with nothing to say. React's
 * `err instanceof Error ? err.message : 'Save failed'`. Without it a blank
 * message renders a dangling "Couldn't save tags: " that tells the operator less
 * than nothing.
 */
private fun causeOr(message: String?, fallback: String): String =
    if (message.isNullOrBlank()) fallback else message

/** Banner copy for a failed tag assignment write. */
fun tagSaveErrorMessage(message: String?): String =
    "Couldn't save tags: ${causeOr(message, "Save failed")}"

/** Banner copy for a vocabulary that would not load. Warning, not error: the field still works. */
fun tagVocabLoadErrorMessage(message: String?): String =
    "Couldn't load tag suggestions: ${causeOr(message, "Load failed")}"

/** Banner copy for a failed inline vocabulary promotion. */
fun tagVocabPromoteErrorMessage(message: String?): String =
    "Couldn't add that tag to your list: ${causeOr(message, "Save failed")}"

/**
 * Everything the panel renders from, and the only place its optimistic writes are
 * decided. Pure and Compose-free so the revert-plus-error contract is testable
 * without a UI harness.
 *
 * [revertTags] and [revertVocab] are the in-flight snapshots: non-null means a
 * write is outstanding and this is what to restore if it fails. They are separate
 * because the two writes are separate, and a failed assignment must not roll back
 * a vocabulary promotion (or the reverse).
 */
data class ProfileTagsState(
    val tags: List<String> = emptyList(),
    val vocab: List<TagDef> = emptyList(),
    val revertTags: List<String>? = null,
    val revertVocab: List<TagDef>? = null,
    val saving: Boolean = false,
    val saveError: String? = null,
    val vocabError: String? = null,
)

/** Show [next] immediately and remember how to undo it. Clears any stale error. */
fun ProfileTagsState.beginSave(next: List<String>): ProfileTagsState =
    copy(tags = next, revertTags = tags, saving = true, saveError = null)

/** The write landed. Settle and drop the undo snapshot. */
fun ProfileTagsState.saveSucceeded(): ProfileTagsState =
    copy(revertTags = null, saving = false)

/**
 * The write failed. Restore the previous list AND surface why, never one without
 * the other. With no snapshot (a late or duplicate failure) the list is left
 * alone, but the message still goes up.
 */
fun ProfileTagsState.saveFailed(message: String?): ProfileTagsState =
    copy(
        tags = revertTags ?: tags,
        revertTags = null,
        saving = false,
        saveError = tagSaveErrorMessage(message),
    )

/** Operator dismissed the error banner. Only the banner clears. */
fun ProfileTagsState.dismissSaveError(): ProfileTagsState = copy(saveError = null)

/** The vocabulary arrived. Replaces the suggestion pool and clears any load warning. */
fun ProfileTagsState.vocabLoaded(next: List<TagDef>): ProfileTagsState =
    copy(vocab = next, vocabError = null)

/**
 * The vocabulary would not load. Warn, but leave the field usable: free-form tags
 * still assign, there are just no suggestions to pick from.
 */
fun ProfileTagsState.vocabLoadFailed(message: String?): ProfileTagsState =
    copy(vocabError = tagVocabLoadErrorMessage(message))

/**
 * Promote a typed name into the vocabulary, optimistically.
 *
 * Returns THIS UNCHANGED when [addTag] rejects the name. That is the one place
 * this panel deliberately swallows a throw, ported from React on purpose: the
 * rejection means "already in your vocabulary" (or blank, or over the 40-char
 * cap), none of which is a failed write. There is simply nothing to persist, and
 * the assignment that prompted it is handled separately by the field's own
 * change callback. Reporting it would be a false alarm.
 *
 * A non-null [revertVocab] on the result doubles as the signal that a vocabulary
 * write is now owed.
 */
fun ProfileTagsState.beginPromoteVocab(name: String): ProfileTagsState {
    val next = runCatching { addTag(vocab, TagDef(name = name, color = DEFAULT_TAG_COLOR, icon = "")) }
        .getOrNull() ?: return this
    return copy(vocab = next, revertVocab = vocab)
}

/** The vocabulary write landed. Keep the new suggestion, drop the snapshot. */
fun ProfileTagsState.promoteVocabSucceeded(): ProfileTagsState = copy(revertVocab = null)

/**
 * The vocabulary write failed. Restore the previous vocabulary AND say so. The
 * assigned tags are untouched: that was a different write, and it may well have
 * succeeded.
 */
fun ProfileTagsState.promoteVocabFailed(message: String?): ProfileTagsState =
    copy(
        vocab = revertVocab ?: vocab,
        revertVocab = null,
        saveError = tagVocabPromoteErrorMessage(message),
    )

/** Pick the vocabulary this scope draws from. */
private fun vocabFor(scope: TagScope, settings: BusinessSettings): List<TagDef> = when (scope) {
    TagScope.HOUSEHOLD -> settings.householdTags
    TagScope.PET -> settings.petTags
}

/**
 * @param scope       which vocabulary and copy to use.
 * @param initialTags the names already on the profile doc. Seeded once, the SettingsEdit convention.
 * @param client      used to stream the vocabulary and to persist an inline promotion.
 * @param onSaveTags  persists the next name list to the profile doc. Supply
 *                    `client.updateKinfolkTags(loaded, it)` or
 *                    `client.updateKinTags(loaded, it)`, passing the record you
 *                    LOADED so the whole-document write round-trips every other field.
 */
@Composable
fun ProfileTagsSection(
    scope: TagScope,
    initialTags: List<String>,
    client: FirestoreClient,
    onSaveTags: suspend (List<String>) -> WriteResult<Unit>,
    modifier: Modifier = Modifier,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    val coroutineScope = rememberCoroutineScope()

    var state by remember(scope) { mutableStateOf(ProfileTagsState(tags = initialTags)) }

    val settingsState by remember { client.businessSettingsStream() }
        .collectAsState(initial = FirestoreResult.Loading)

    // The vocabulary is a live stream here rather than React's one-shot read, so a
    // tag added in the Tags settings panel shows up as a suggestion without a
    // reload. A stream error is a warning, not a blocker: the field keeps working.
    LaunchedEffect(settingsState, scope) {
        state = when (val s = settingsState) {
            is FirestoreResult.Data -> state.vocabLoaded(vocabFor(scope, s.value))
            is FirestoreResult.Error -> state.vocabLoadFailed(s.message)
            FirestoreResult.Loading -> state
        }
    }

    /** The loaded settings, needed to swap one vocabulary without clobbering the rest. */
    fun loadedSettings(): BusinessSettings? = when (val s = settingsState) {
        is FirestoreResult.Data -> s.value
        else -> null
    }

    fun saveTags(next: List<String>) {
        state = state.beginSave(next)
        coroutineScope.launch {
            state = when (val r = onSaveTags(next)) {
                is WriteResult.Ok -> state.saveSucceeded()
                is WriteResult.Err -> state.saveFailed(r.message)
            }
        }
    }

    fun promoteVocab(name: String) {
        val promoted = state.beginPromoteVocab(name)
        // A null snapshot means addTag rejected the name (already present, blank,
        // or over the cap), so there is nothing to write and nothing to report.
        if (promoted.revertVocab == null) return
        state = promoted

        val settings = loadedSettings()
        if (settings == null) {
            // Fail loud rather than write a vocabulary on top of settings we never
            // read: this save seam sends the whole document, so that would wipe
            // every other business setting.
            state = state.promoteVocabFailed("your settings are still loading")
            return
        }

        val nextVocab = promoted.vocab
        coroutineScope.launch {
            val result = when (scope) {
                TagScope.HOUSEHOLD -> client.saveHouseholdTagVocabulary(settings, nextVocab)
                TagScope.PET -> client.savePetTagVocabulary(settings, nextVocab)
            }
            state = when (result) {
                is WriteResult.Ok -> state.promoteVocabSucceeded()
                is WriteResult.Err -> state.promoteVocabFailed(result.message)
            }
        }
    }

    DenPanel(title = "Tags", subtitle = tagScopeSubtitle(scope), modifier = modifier) {
        Column(
            modifier = Modifier.fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(dims.space3),
        ) {
            state.vocabError?.let { warning ->
                AuntieBanner(tone = AuntieBannerTone.Warning, title = "Tag suggestions unavailable") {
                    Text(warning, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                }
            }
            state.saveError?.let { error ->
                AuntieBanner(
                    tone = AuntieBannerTone.Error,
                    title = "Save failed",
                    onDismiss = { state = state.dismissSaveError() },
                ) {
                    Text(error, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                }
            }
            TagAssignField(
                value = state.tags,
                vocab = state.vocab,
                onChange = { saveTags(it) },
                onCreateVocab = { promoteVocab(it) },
                enabled = !state.saving,
                inputLabel = tagScopeInputLabel(scope),
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}
