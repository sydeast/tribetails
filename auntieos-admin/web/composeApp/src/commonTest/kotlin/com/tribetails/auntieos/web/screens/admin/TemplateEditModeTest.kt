package com.tribetails.auntieos.web.screens.admin

import com.tribetails.auntieos.web.data.TemplateService
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** #953 PR 1: FULL/SUBJECT_ONLY/READ_ONLY save gating so this app never
 * overwrites hand-authored HTML or a visual template. Mirror of android. */
class TemplateEditModeTest {
    private fun tpl(body: String, html: String?, format: String? = null) = TemplateService.EmailTemplate(
        templateId = "k", subject = "S", body = body, html = html, title = "k",
        description = null, tags = emptyList(), category = null, format = format,
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
}
