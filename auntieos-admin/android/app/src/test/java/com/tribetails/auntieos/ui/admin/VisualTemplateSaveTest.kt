package com.tribetails.auntieos.ui.admin

import androidx.compose.runtime.saveable.SaverScope
import com.tribetails.auntieos.data.repository.TemplateRepository
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #953 PR 5: the Android rule that edit screens never rebuild a model from
 * form state. Every field comes back as loaded unless its control changed.
 */
class VisualTemplateSaveTest {

    private val original = TemplateRepository.EmailTemplate(
        templateId = "auth.password.reset", subject = "Reset", body = "", html = null,
        title = "", description = "", tags = listOf("auth", "account"), category = "",
        format = "visual", headline = "Reset your password",
        content = "<p>Hi <strong>{{displayName}}</strong>,<br>tap below.</p>",
    )

    private fun editedFirstBlock(draft: VisualDraft, newText: String): VisualDraft {
        val first = draft.blocks[0] as EmailBlock.TextBlock
        val r = applyBlockEdit(first, newText) as BlockEdit.Accepted
        return draft.copy(blocks = draft.blocks.toMutableList().also { it[0] = r.block })
    }

    @Test fun anUntouchedDraftSavesTheTemplateAsLoaded() {
        assertEquals(original, visualTemplateToSave(original, VisualDraft.from(original)))
    }

    @Test fun changingTheSubjectChangesOnlyTheSubject() {
        val saved = visualTemplateToSave(original, VisualDraft.from(original).copy(subject = "New"))
        assertEquals(original.copy(subject = "New"), saved)
    }

    @Test fun anEmptyDescriptionNobodyTouchedStaysEmptyNotNull() {
        assertEquals("", visualTemplateToSave(original, VisualDraft.from(original)).description)
        assertEquals("", visualTemplateToSave(original, VisualDraft.from(original)).category)
    }

    @Test fun aDescriptionTheOperatorClearedBecomesNull() {
        val withNote = original.copy(description = "Sent on request")
        assertNull(visualTemplateToSave(withNote, VisualDraft.from(withNote).copy(description = "")).description)
    }

    @Test fun aTitleClearedByTheOperatorFallsBackToTheKey() {
        val named = original.copy(title = "Password reset")
        assertEquals("auth.password.reset", visualTemplateToSave(named, VisualDraft.from(named).copy(title = " ")).title)
    }

    @Test fun untouchedContentIsWrittenBackByteForByte() {
        // `<br>` without the slash is not the sanitizer's spelling; it still comes back as stored.
        assertEquals(original.content, visualTemplateToSave(original, VisualDraft.from(original).copy(headline = "H")).content)
    }

    @Test fun editedContentIsSerializedFromTheBlocks() {
        val draft = editedFirstBlock(VisualDraft.from(original), "Hi {{displayName}},\ntap the button.")
        assertEquals(
            "<p>Hi <strong>{{displayName}}</strong>,<br>tap the button.</p>",
            visualTemplateToSave(original, draft).content,
        )
    }

    @Test fun onlyACompleteVisualDocUsesTheVisualEditor() {
        assertTrue(usesVisualEditor(original, creating = false))
        assertFalse(usesVisualEditor(original, creating = true))
        assertFalse(usesVisualEditor(original.copy(content = null), creating = false))
        assertFalse(usesVisualEditor(original.copy(headline = null), creating = false))
        assertFalse(usesVisualEditor(original.copy(format = "mjml"), creating = false))
        assertFalse(usesVisualEditor(original.copy(format = null), creating = false))
    }

    @Test fun problems() {
        val draft = VisualDraft.from(original)
        assertNull(visualDraftProblem(draft))
        assertEquals(DRAFT_NEEDS_SUBJECT, visualDraftProblem(draft.copy(subject = " ")))
        assertEquals(DRAFT_NEEDS_HEADLINE, visualDraftProblem(draft.copy(headline = "")))
        assertEquals(DRAFT_BROKEN_MERGE_FIELD, visualDraftProblem(draft.copy(subject = "Hi {{na")))
        assertEquals(DRAFT_BROKEN_MERGE_FIELD, visualDraftProblem(editedFirstBlock(draft, "Hi {{displayName}},\ntap {{li")))
    }

    // Review Focus 4
    @Test fun theDraftSurvivesSaveAndRestore() {
        val edited = editedFirstBlock(VisualDraft.from(original), "Hi {{displayName}},\ntap here 😀.")
            .copy(subject = "S2", tags = listOf("x"))
        val scope = SaverScope { true }
        val saved = with(VisualDraftSaver) { scope.save(edited) }!!
        val restored = VisualDraftSaver.restore(saved)!!
        assertEquals(serializeEmailContent(edited.blocks), serializeEmailContent(restored.blocks))
        assertEquals(edited.copy(blocks = restored.blocks), restored)
    }

    @Test fun aNullDescriptionAndCategoryStayNullUnlessTheirControlChanges() {
        val bare = original.copy(description = null, category = null)
        val untouched = visualTemplateToSave(bare, VisualDraft.from(bare))
        assertNull(untouched.description)
        assertNull(untouched.category)
        assertEquals(bare, untouched)
        val draft = editedFirstBlock(VisualDraft.from(bare), "Hi {{displayName}},\ntap it.").copy(subject = "S2", tags = listOf("x"))
        val otherFieldsEdited = visualTemplateToSave(bare, draft)
        assertNull(otherFieldsEdited.description)
        assertNull(otherFieldsEdited.category)
        assertEquals("S2", otherFieldsEdited.subject)
    }

    // Review Focus 4: what rotation restores diff-saves like the draft that was on screen.
    @Test fun aRestoredDraftDiffSavesLikeTheOriginal() {
        val scope = SaverScope { true }
        fun rotate(d: VisualDraft) = VisualDraftSaver.restore(with(VisualDraftSaver) { scope.save(d) }!!)!!

        val untouched = visualTemplateToSave(original, rotate(VisualDraft.from(original)))
        assertEquals(original, untouched)
        assertEquals(original.content, untouched.content)

        val twoBlocks = original.copy(content = "<p>Hi <strong>{{displayName}}</strong>,<br>tap below.</p><p>Thanks &amp; bye.</p>")
        val edited = visualTemplateToSave(twoBlocks, rotate(editedFirstBlock(VisualDraft.from(twoBlocks), "Hi {{displayName}},\ntap here.")))
        assertEquals("<p>Hi <strong>{{displayName}}</strong>,<br>tap here.</p><p>Thanks &amp; bye.</p>", edited.content)
        assertEquals(twoBlocks.copy(content = edited.content), edited)
    }

    @Test fun thePreviewIsAskedForTheDraftUnderTheTemplateKey() {
        val request = VisualDraft.from(original).copy(subject = "S2").previewRequest(original.templateId)
        assertEquals(EmailPreviewRequest("S2", "Reset your password", original.content!!, "auth.password.reset"), request)
    }
}
