package com.tribetails.auntieos.ui.admin

import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.listSaver
import com.tribetails.auntieos.data.repository.TemplateRepository

/** #953: `emailTemplates/{id}.format` for the headline + content shape. */
internal const val VISUAL_FORMAT = "visual"

internal const val DRAFT_NEEDS_SUBJECT = "Add a subject."
internal const val DRAFT_NEEDS_HEADLINE = "Add a headline."
internal const val DRAFT_BROKEN_MERGE_FIELD = "A merge field is incomplete. Finish it as {{name}} or delete it."

/** Everything the visual editor lets the operator change, as the controls hold it. */
data class VisualDraft(
    val subject: String,
    val headline: String,
    val blocks: List<EmailBlock>,
    val title: String,
    val description: String,
    val category: String,
    val tags: List<String>,
) {
    companion object {
        fun from(t: TemplateRepository.EmailTemplate) = VisualDraft(
            subject = t.subject,
            headline = t.headline.orEmpty(),
            blocks = parseEmailContent(t.content.orEmpty()),
            title = t.title,
            description = t.description.orEmpty(),
            category = t.category.orEmpty(),
            tags = t.tags,
        )
    }
}

/** One previewEmailTemplate request. Equal requests are not sent twice. */
data class EmailPreviewRequest(
    val subject: String,
    val headline: String,
    val content: String,
    val catalogKey: String?,
)

/** The preview asks for [catalogKey]'s sample values (see [previewCatalogKey]). */
fun VisualDraft.previewRequest(catalogKey: String) =
    EmailPreviewRequest(subject, headline, serializeEmailContent(blocks), catalogKey.ifBlank { null })

/**
 * The catalog key whose sample values the preview should use: the key that
 * sends [templateId], the way web resolves it (`fieldsForTemplate` in
 * auntieos-admin/src/lib/templateFormat.ts). A binding pointing a key at this
 * template wins, an active one first. `listTemplateBindings` reports a binding
 * with no `active` field as inactive although dispatch sends through it, so an
 * inactive match still beats none. With no binding the template key is its
 * own catalog key (dispatch's default), which covers every seed.
 */
fun previewCatalogKey(templateId: String, bindings: List<TemplateRepository.TemplateBinding>): String {
    val matches = bindings.filter { it.templateId == templateId }
    return (matches.firstOrNull { it.active } ?: matches.firstOrNull())?.catalogKey ?: templateId
}

/**
 * The visual editor opens only for a doc that is really in the visual shape.
 * Anything else (an unknown format, a visual flag without its fields, a new
 * template) stays with PR 1's modes in the old editor.
 */
fun usesVisualEditor(template: TemplateRepository.EmailTemplate, creating: Boolean): Boolean =
    !creating && template.format == VISUAL_FORMAT && template.headline != null && template.content != null

/**
 * The template a visual Save sends. Diff against what was loaded, never a
 * rebuild from form state: a field whose control is untouched goes back
 * exactly as it came, including "" versus null, and untouched content goes
 * back byte for byte.
 */
fun visualTemplateToSave(
    original: TemplateRepository.EmailTemplate,
    draft: VisualDraft,
): TemplateRepository.EmailTemplate {
    val start = VisualDraft.from(original)
    val blocks = withPristineBlocks(start.blocks, draft.blocks)
    return original.copy(
        subject = draft.subject,
        format = VISUAL_FORMAT,
        headline = draft.headline,
        content = if (blocks == start.blocks) original.content else serializeEmailContent(blocks),
        title = if (draft.title == start.title) original.title else draft.title.ifBlank { original.templateId },
        description = if (draft.description == start.description) original.description else draft.description.ifBlank { null },
        category = if (draft.category == start.category) original.category else draft.category.ifBlank { null },
        tags = if (draft.tags == start.tags) original.tags else draft.tags,
    )
}

/**
 * Each draft block that reads the same as its loaded block (same kind, same
 * tags, same words in the same runs) is swapped for the loaded one, so a block
 * edited and typed back is written with its stored spelling (`&nbsp;`, `&#38;`)
 * instead of a re-escape. Only the source spelling of text runs is ignored.
 */
private fun withPristineBlocks(start: List<EmailBlock>, draft: List<EmailBlock>): List<EmailBlock> {
    if (start.size != draft.size) return draft
    return draft.mapIndexed { i, b -> if (withoutSpelling(b) == withoutSpelling(start[i])) start[i] else b }
}

private fun withoutSpelling(b: EmailBlock): EmailBlock =
    if (b is EmailBlock.TextBlock) b.copy(inlines = b.inlines.map(::withoutSpelling)) else b

private fun withoutSpelling(n: EmailInline): EmailInline = when (n) {
    is EmailInline.Text -> n.copy(raw = null)
    is EmailInline.Element -> n.copy(children = n.children.map(::withoutSpelling))
    else -> n
}

/** Why Save is off, or null when it can go. */
fun visualDraftProblem(draft: VisualDraft): String? = when {
    draft.subject.isBlank() -> DRAFT_NEEDS_SUBJECT
    draft.headline.isBlank() -> DRAFT_NEEDS_HEADLINE
    hasBrokenMergeField(draft.subject) || hasBrokenMergeField(draft.headline) ||
        draft.blocks.any { it is EmailBlock.TextBlock && hasBrokenMergeField(it.plainText()) } -> DRAFT_BROKEN_MERGE_FIELD
    else -> null
}

/**
 * Rotation recreates the Activity (the manifest declares no configChanges).
 * The body is saved as its HTML, which the round trip guarantees, so the
 * restored blocks serialize to exactly what was on screen.
 */
val VisualDraftSaver: Saver<VisualDraft, Any> = listSaver(
    save = {
        listOf(
            it.subject, it.headline, serializeEmailContent(it.blocks),
            it.title, it.description, it.category, ArrayList(it.tags),
        )
    },
    restore = {
        @Suppress("UNCHECKED_CAST")
        VisualDraft(
            subject = it[0] as String,
            headline = it[1] as String,
            blocks = parseEmailContent(it[2] as String),
            title = it[3] as String,
            description = it[4] as String,
            category = it[5] as String,
            tags = it[6] as List<String>,
        )
    },
)
