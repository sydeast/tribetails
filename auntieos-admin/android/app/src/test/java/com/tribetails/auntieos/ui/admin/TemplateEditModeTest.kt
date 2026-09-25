package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.repository.TemplateRepository
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** #953 PR 1: FULL/SUBJECT_ONLY/READ_ONLY save gating so this app never
 * overwrites hand-authored HTML or a visual template. Mirror of web. */
class TemplateEditModeTest {
    private fun tpl(
        body: String,
        html: String?,
        format: String? = null,
        headline: String? = null,
        content: String? = null,
    ) = TemplateRepository.EmailTemplate(
        templateId = "k", subject = "S", body = body, html = html, title = "k",
        description = null, tags = emptyList(), category = null, format = format,
        headline = headline, content = content,
    )

    @Test fun markdownDerivedHtmlIsNotHandAuthored() {
        val body = "Hi **there**\n\n- one\n"
        assertFalse(htmlIsHandAuthored(body, markdownToHtml(body)))
    }

    @Test fun nullOrEmptyHtmlIsNotHandAuthored() {
        assertFalse(htmlIsHandAuthored("x", null))
        assertFalse(htmlIsHandAuthored("x", ""))
    }

    @Test fun seedStyleHtmlIsHandAuthored() {
        assertTrue(htmlIsHandAuthored("Hi", "<!DOCTYPE html><html><body><a href='{{link}}' class='button'>Go</a></body></html>"))
    }

    @Test fun modes() {
        assertEquals(TemplateEditMode.FULL, templateEditMode(tpl("b", null), creating = false))
        assertEquals(TemplateEditMode.SUBJECT_ONLY, templateEditMode(tpl("b", "<div>custom</div>"), creating = false))
        assertEquals(TemplateEditMode.READ_ONLY, templateEditMode(tpl("", null, format = "visual"), creating = false))
        assertEquals(TemplateEditMode.READ_ONLY, templateEditMode(tpl("b", null, format = "mjml"), creating = false))
        assertEquals(TemplateEditMode.FULL, templateEditMode(tpl("b", "<div>custom</div>"), creating = true))
    }

    @Test fun subjectOnlySaveKeepsBodyAndHtmlByteForByte() {
        val original = tpl("Body {{link}}", "<p><a href='{{link}}' class='button'>Go</a></p>")
        val saved = templateToSave(original, TemplateEditMode.SUBJECT_ONLY, editedSubject = "New", editedBody = "ignored")
        assertEquals("New", saved.subject)
        assertEquals(original.body, saved.body)
        assertEquals(original.html, saved.html)
    }

    @Test fun fullSaveDerivesHtmlFromTheEditedBody() {
        val saved = templateToSave(tpl("old", null), TemplateEditMode.FULL, editedSubject = "S", editedBody = "**new**")
        assertEquals("**new**", saved.body)
        assertEquals(markdownToHtml("**new**"), saved.html)
    }

    @Test fun readOnlySaveThrows() {
        assertThrows(IllegalStateException::class.java) {
            templateToSave(tpl("b", null, format = "visual"), TemplateEditMode.READ_ONLY, editedSubject = "S", editedBody = "b")
        }
    }

    @Test fun showsMarkdownPreviewOnlyInFull() {
        assertTrue(showsMarkdownPreview(TemplateEditMode.FULL))
        assertFalse(showsMarkdownPreview(TemplateEditMode.SUBJECT_ONLY))
        assertFalse(showsMarkdownPreview(TemplateEditMode.READ_ONLY))
    }

    @Test fun canReassignCategoryOnlyWhenFormatIsNullOrARealVisualTemplate() {
        assertTrue(canReassignCategory(tpl("b", null)))
        assertTrue(canReassignCategory(tpl("Hi", "<!DOCTYPE html><html><body><a href='{{link}}' class='button'>Go</a></body></html>")))
        // Ruling C1: a real visual template (format + headline + content all
        // present) drags to a category like any other; the drag saves through
        // saveTemplatePayload in the visual shape.
        assertTrue(canReassignCategory(tpl("", null, format = "visual", headline = "Reset your password", content = "<p>Hi</p>")))
        // A visual flag missing its fields, and any other unknown format, stay refused.
        assertFalse(canReassignCategory(tpl("", null, format = "visual")))
        assertFalse(canReassignCategory(tpl("b", null, format = "mjml")))
    }
}
