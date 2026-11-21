package com.tribetails.auntieos.web.screens.admin

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** #2251: the desktop editor holds back a subject or body the sender could not fill in. */
class TemplateMarkupTest {
    @Test
    fun anUnclosedIfNamesTheFieldAndTheMissingClose() {
        assertEquals(
            "The subject cannot be sent as written. {{#if}} is never closed. Add {{/if}} where that part ends.",
            templateMarkupError("The subject", "{{#if isQuote}}Your quote is ready"),
        )
    }

    @Test
    fun aStrayCloseAWrongCloseAndALoneElseAreEachNamed() {
        assertTrue(templateMarkupError("The body", "Paid{{/if}}")!!.contains("{{/if}} closes a part that was never opened"))
        assertTrue(templateMarkupError("The body", "{{#if a}}x{{/unless}}")!!.contains("{{#if}} is closed with {{/unless}}"))
        assertTrue(templateMarkupError("The body", "a {{else}} b")!!.contains("{{else}} sits outside any {{#if}}"))
    }

    @Test
    fun halfAFieldIsCaught() {
        assertTrue(templateMarkupError("The subject", "Hi {{kinName and more")!!.contains("A field is not written correctly"))
    }

    /** #2251 review: a comment or an escaped tag is never filled in, so it never holds Save back. */
    @Test
    fun tagsInsideACommentOrEscapedPairWithNothing() {
        listOf(
            "{{#if a}}x{{else if b}}y{{else}}z{{/if}}",
            "{{#each items as |item i|}}{{item.name}}{{/each}}",
            "{{!-- {{#if x}} kept for later --}}Hi {{kinName}}",
            "{{! {{/if}} }}Hi",
            "Type \\{{#if x}} to show a part",
        ).forEach { assertNull(templateMarkupError("The body", it), it) }
        assertTrue(templateMarkupError("The body", "{{!-- note --}}{{#if a}}x")!!.contains("{{#if}} is never closed"))
    }
    @Test
    fun goodTemplatesPass() {
        listOf(
            "No fields",
            "Hi {{kinfolkName}}",
            "{{#if isQuote}}Quote{{else}}Invoice{{/if}} for {{kinName}}",
            "- {{#each visits}}{{this.date}}{{/each}}",
            "{{#unless paid}}Due {{dueDate}}{{/unless}}",
            "",
        ).forEach { assertNull(templateMarkupError("The body", it), it) }
    }
}
