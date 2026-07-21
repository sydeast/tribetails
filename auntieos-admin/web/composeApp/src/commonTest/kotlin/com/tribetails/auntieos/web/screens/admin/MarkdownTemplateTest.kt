package com.tribetails.auntieos.web.screens.admin

import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * 13.3/13.4 Template Bank rich editor: tests for the constrained Markdown -> HTML
 * converter (what populates EmailTemplate.html, sent as-is by SendGrid) and the
 * toolbar insertion helpers. Mirror of the android MarkdownTemplateTest. The subset:
 * headings (#/##/###), **bold**, _italic_, [text](url), ![alt](url), "- " bullets,
 * blank-line paragraphs, single newline -> <br>. Handlebars {{vars}} pass through;
 * HTML special chars are escaped (never trust the input as HTML).
 */
class MarkdownTemplateTest {

    // ---- markdownToHtml: blocks ----

    @Test
    fun blank_input_is_empty() {
        assertEquals("", markdownToHtml(""))
        assertEquals("", markdownToHtml("   \n  \n"))
    }

    @Test
    fun plain_line_is_a_paragraph() {
        assertEquals("<p>Hello there</p>", markdownToHtml("Hello there"))
    }

    @Test
    fun headings_one_two_three() {
        assertEquals("<h1>Big</h1>", markdownToHtml("# Big"))
        assertEquals("<h2>Mid</h2>", markdownToHtml("## Mid"))
        assertEquals("<h3>Small</h3>", markdownToHtml("### Small"))
    }

    @Test
    fun blank_line_separates_paragraphs() {
        assertEquals("<p>one</p><p>two</p>", markdownToHtml("one\n\ntwo"))
    }

    @Test
    fun single_newline_within_paragraph_is_break() {
        assertEquals("<p>line one<br>line two</p>", markdownToHtml("line one\nline two"))
    }

    @Test
    fun consecutive_dash_lines_form_one_list() {
        assertEquals("<ul><li>one</li><li>two</li></ul>", markdownToHtml("- one\n- two"))
    }

    // ---- markdownToHtml: inline ----

    @Test
    fun bold_italic_link_image_inline() {
        assertEquals("<p>say <strong>hi</strong></p>", markdownToHtml("say **hi**"))
        assertEquals("<p>say <em>hi</em></p>", markdownToHtml("say _hi_"))
        assertEquals("<p><a href=\"https://x.io\">click</a></p>", markdownToHtml("[click](https://x.io)"))
        assertEquals("<p><img src=\"https://x.io/l.png\" alt=\"logo\"></p>", markdownToHtml("![logo](https://x.io/l.png)"))
    }

    @Test
    fun handlebars_vars_pass_through_untouched() {
        assertEquals("<p>Hi {{kinfolkName}}</p>", markdownToHtml("Hi {{kinfolkName}}"))
        assertEquals("<p><strong>{{kinfolkName}}</strong></p>", markdownToHtml("**{{kinfolkName}}**"))
    }

    @Test
    fun html_special_chars_are_escaped() {
        assertEquals("<p>a &lt; b &amp; c &gt; d</p>", markdownToHtml("a < b & c > d"))
    }

    @Test
    fun escaping_does_not_break_markdown_syntax() {
        // The bold markers survive escaping; the inner < is escaped.
        assertEquals("<p><strong>a &lt; b</strong></p>", markdownToHtml("**a < b**"))
    }

    // ---- insertion helpers (toolbar) ----

    @Test
    fun wrapSelection_wraps_the_selected_range() {
        val r = wrapSelection("say hi there", 4, 6, "**", "**")
        assertEquals("say **hi** there", r.text)
        // cursor lands after the wrapped word
        assertEquals(10, r.cursor)
    }

    @Test
    fun wrapSelection_with_no_selection_inserts_markers_with_cursor_between() {
        val r = wrapSelection("ab", 1, 1, "**", "**")
        assertEquals("a****b", r.text)
        assertEquals(3, r.cursor) // between the marker pairs
    }

    @Test
    fun insertSnippet_inserts_at_cursor_and_moves_cursor_past_it() {
        val r = insertSnippet("Hi ", 3, "{{kinfolkName}}")
        assertEquals("Hi {{kinfolkName}}", r.text)
        assertEquals("Hi {{kinfolkName}}".length, r.cursor)
    }
}
