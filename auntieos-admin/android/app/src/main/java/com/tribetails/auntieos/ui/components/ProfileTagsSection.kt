package com.tribetails.auntieos.ui.components

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.data.model.DEFAULT_TAG_COLOR
import com.tribetails.auntieos.data.model.TagDef
import com.tribetails.auntieos.data.model.TagScope
import com.tribetails.auntieos.data.model.addTag
import com.tribetails.auntieos.ui.theme.AuntieTheme
import kotlinx.coroutines.launch
import kotlin.coroutines.cancellation.CancellationException

/**
 * The "Tags" panel shared by the kinfolk profile (household tags) and the kin
 * profile (pet tags). Ported from the React admin
 * (auntieos-admin src/components/ProfileTagsSection.tsx); the android tree
 * shares no code with commonMain, so this is an independent port written from
 * that source and pinned by ProfileTagsSectionTest.kt.
 *
 * Each add and remove saves the moment it happens, optimistically. A save
 * failure REVERTS the chip and SURFACES the error in a banner: both halves,
 * always. A revert on its own would be a silent lie, telling the operator a tag
 * came off when it never did.
 *
 * A typed name not yet in the vocabulary can be promoted to it inline ("add to
 * your tags"): that both assigns the name and adds a default-colored [TagDef]
 * to the right vocabulary list, so it becomes a reusable suggestion
 * (recolorable later in the Tags settings panel).
 *
 * #2204 / #2205: the promotion sends the ONE name (`changeBusinessTags`), which
 * the server adds to the list as stored, never this panel's copy of the list.
 * It is offered only once the list has loaded and only to the owner: before the
 * load, and after a failed one, the field cannot tell a new name from one
 * already on the list. A loading line shows while the list loads; after a failed
 * load the warning stays and typed tags still save on the profile.
 *
 * Loading and persisting are passed in rather than reached for, so the panel
 * carries no Firebase dependency and the profile screen keeps ownership of its
 * repository wiring.
 */

// ── pure helpers ─────────────────────────────────────────────────────────────

/** The scope-dependent copy on the panel. */
data class ProfileTagsCopy(val subtitle: String, val inputLabel: String)

/** Panel copy per scope, matching the React SCOPE_COPY table verbatim. */
fun profileTagsCopy(scope: TagScope): ProfileTagsCopy = when (scope) {
    TagScope.HOUSEHOLD -> ProfileTagsCopy(
        subtitle = "Labels on this household. Broadcasts and KinTale rules can target them.",
        inputLabel = "Add a household tag",
    )
    TagScope.PET -> ProfileTagsCopy(
        subtitle = "Labels on this pet, e.g. Reactive or On meds.",
        inputLabel = "Add a pet tag",
    )
}

/** The underlying message, or [fallback] when the failure carried nothing useful. */
private fun detail(error: Throwable?, fallback: String): String =
    error?.message?.takeIf { it.isNotBlank() } ?: fallback

/** Banner copy for a failed assignment save. */
fun tagSaveErrorMessage(error: Throwable?): String =
    "Couldn't save tags: ${detail(error, "Save failed")}"

/** Banner copy for a vocabulary that would not load. The field stays usable. */
fun tagVocabLoadErrorMessage(error: Throwable?): String =
    "Couldn't load tag suggestions: ${detail(error, "Load failed")}"

/** Banner copy for a failed inline vocabulary promotion. */
fun tagVocabAddErrorMessage(error: Throwable?): String =
    "Couldn't add that tag to your list: ${detail(error, "Save failed")}"

/** Where an optimistic assignment save leaves the panel. */
data class TagSaveOutcome(val tags: List<String>, val error: String?)

/**
 * Resolve an optimistic save. Success keeps the attempted list and clears the
 * banner; failure reverts to [previous] AND produces a message. The two are
 * returned together so a caller cannot do one without the other.
 */
fun tagSaveOutcome(
    previous: List<String>,
    attempted: List<String>,
    error: Throwable?,
): TagSaveOutcome =
    if (error == null) {
        TagSaveOutcome(tags = attempted, error = null)
    } else {
        TagSaveOutcome(tags = previous, error = tagSaveErrorMessage(error))
    }

/** Where the vocabulary read stands. "add to your tags" waits for [READY]. */
enum class TagVocabLoad { LOADING, READY, FAILED }

/** The line shown while the suggestions load. The same words as the React panel. */
const val TAG_SUGGESTIONS_LOADING = "Loading tag suggestions…"

/**
 * #2204: offer "add to your tags" only once the list has loaded and only to the
 * owner. [isOwner] null means the check has not answered yet, which is a no.
 * Pure; tested.
 */
fun vocabAddOffered(load: TagVocabLoad, isOwner: Boolean?): Boolean =
    load == TagVocabLoad.READY && isOwner == true

/** Where an optimistic vocabulary promotion leaves the panel. */
data class TagVocabOutcome(val vocab: List<TagDef>, val error: String?)

/** Resolve an optimistic vocabulary write, on the same revert-and-surface rule. */
fun tagVocabOutcome(
    previous: List<TagDef>,
    attempted: List<TagDef>,
    error: Throwable?,
): TagVocabOutcome =
    if (error == null) {
        TagVocabOutcome(vocab = attempted, error = null)
    } else {
        TagVocabOutcome(vocab = previous, error = tagVocabAddErrorMessage(error))
    }

/**
 * Grow the vocabulary with a name typed on a profile, default-colored and with
 * no icon. Returns null when there is nothing to persist: the name is blank,
 * over the length cap, or already in the vocabulary.
 *
 * That null is the ONE intentional swallow in this file, and it matches React:
 * the name is already assignable, the assignment itself is handled by the
 * field's own onChange, and nothing failed. Every other failure surfaces.
 */
fun promoteTagToVocab(vocab: List<TagDef>, name: String): List<TagDef>? = try {
    addTag(vocab, TagDef(name = name, color = DEFAULT_TAG_COLOR, icon = ""))
} catch (rejected: IllegalArgumentException) {
    null
}

// ── composable ───────────────────────────────────────────────────────────────

/**
 * @param scope        Which vocabulary and copy this profile uses.
 * @param initialTags  The names already on the profile doc. Seeded once.
 * @param onSaveTags   Persists the next name list to the profile doc
 *                     (`kinfolk/{id}.tags` or `kin/{id}.tags`). Throws on failure.
 * @param loadVocab    Reads the scope's vocabulary from `business_settings`.
 * @param loadIsOwner  Whether this sign-in is the owner, the only one who may
 *                     add to the business's tag list.
 * @param onAddVocab   Adds ONE name to the stored list (`changeBusinessTags`) and
 *                     answers with this scope's list as stored after the add.
 *                     Throws on failure.
 */
@Composable
fun ProfileTagsSection(
    scope: TagScope,
    initialTags: List<String>,
    onSaveTags: suspend (List<String>) -> Unit,
    loadVocab: suspend () -> List<TagDef>,
    loadIsOwner: suspend () -> Boolean,
    onAddVocab: suspend (String) -> List<TagDef>,
    modifier: Modifier = Modifier,
) {
    val c = AuntieTheme.colors
    val copy = remember(scope) { profileTagsCopy(scope) }
    val savingScope = rememberCoroutineScope()

    var tags by remember { mutableStateOf(initialTags) }
    var vocab by remember { mutableStateOf(emptyList<TagDef>()) }
    var vocabLoad by remember { mutableStateOf(TagVocabLoad.LOADING) }
    var isOwner by remember { mutableStateOf<Boolean?>(null) }
    var vocabError by remember { mutableStateOf<String?>(null) }
    var saveError by remember { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }

    LaunchedEffect(scope) {
        vocabLoad = TagVocabLoad.LOADING
        try {
            vocab = loadVocab()
            vocabError = null
            vocabLoad = TagVocabLoad.READY
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: Throwable) {
            // The field stays usable without suggestions, but the operator is
            // told the autocomplete is not showing everything it should.
            vocabError = tagVocabLoadErrorMessage(failure)
            vocabLoad = TagVocabLoad.FAILED
        }
    }

    LaunchedEffect(Unit) {
        isOwner = try {
            loadIsOwner()
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: Throwable) {
            // Unknown is a no: the add is a Business Settings edit.
            false
        }
    }

    fun handleChange(next: List<String>) {
        val previous = tags
        tags = next
        saving = true
        saveError = null
        savingScope.launch {
            val failure = try {
                onSaveTags(next)
                null
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failed: Throwable) {
                failed
            }
            val outcome = tagSaveOutcome(previous = previous, attempted = next, error = failure)
            tags = outcome.tags
            saveError = outcome.error
            saving = false
        }
    }

    fun handleCreateVocab(name: String) {
        // Belt and braces: the field is not handed this handler unless the list
        // has loaded and the owner is signed in (see [vocabAddOffered]).
        if (!vocabAddOffered(vocabLoad, isOwner)) return
        val next = promoteTagToVocab(vocab, name) ?: return
        val previous = vocab
        vocab = next
        savingScope.launch {
            var stored: List<TagDef> = next
            val failure = try {
                stored = onAddVocab(next.last().name)
                null
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failed: Throwable) {
                failed
            }
            // Success shows the list as the server now holds it, tags added
            // elsewhere included; failure reverts and says why.
            val outcome = tagVocabOutcome(previous = previous, attempted = stored, error = failure)
            vocab = outcome.vocab
            if (outcome.error != null) saveError = outcome.error
        }
    }

    DenPanel(title = "Tags", subtitle = copy.subtitle, modifier = modifier) {
        Column(Modifier.fillMaxWidth()) {
            if (vocabLoad == TagVocabLoad.LOADING) {
                Text(TAG_SUGGESTIONS_LOADING, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                Spacer(Modifier.height(12.dp))
            }
            vocabError?.let { message ->
                AuntieBanner(
                    tone = AuntieBannerTone.Warning,
                    title = "Tag suggestions unavailable",
                ) {
                    Text(message, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                }
                Spacer(Modifier.height(12.dp))
            }
            saveError?.let { message ->
                AuntieBanner(
                    tone = AuntieBannerTone.Error,
                    title = "Save failed",
                    onDismiss = { saveError = null },
                ) {
                    Text(message, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                }
                Spacer(Modifier.height(12.dp))
            }
            TagAssignField(
                value = tags,
                vocab = vocab,
                onChange = { handleChange(it) },
                onCreateVocab = if (vocabAddOffered(vocabLoad, isOwner)) { name -> handleCreateVocab(name) } else null,
                enabled = !saving,
                inputLabel = copy.inputLabel,
            )
        }
    }
}
