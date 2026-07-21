package com.tribetails.auntieos.ui.admin

import org.junit.Assert.assertEquals
import org.junit.Test

/** 13.3/13.4 Markdown -> HTML converter + toolbar helper tests (android). Mirror of web. */
class MarkdownTemplateTest {

    @Test fun blank_input_is_empty() {
        assertEquals("", markdownToHtml(""))
        assertEquals("", markdownToHtml("   \n  \n"))
    }

    @Test fun plain_line_is_a_paragraph() {
        assertEquals("<p>Hello there</p>", markdownToHtml("Hello there"))
    }

    @Test fun headings_one_two_three() {
        assertEquals("<h1>Big</h1>", markdownToHtml("# Big"))
        assertEquals("<h2>Mid</h2>", markdownToHtml("## Mid"))
        assertEquals("<h3>Small</h3>", markdownToHtml("### Small"))
    }

    @Test fun blank_line_separates_paragraphs() {
        assertEquals("<p>one</p><p>two</p>", markdownToHtml("one\n\ntwo"))
    }

    @Test fun single_newline_within_paragraph_is_break() {
        assertEquals("<p>line one<br>line two</p>", markdownToHtml("line one\nline two"))
    }

    @Test fun consecutive_dash_lines_form_one_list() {
        assertEquals("<ul><li>one</li><li>two</li></ul>", markdownToHtml("- one\n- two"))
    }

    @Test fun bold_italic_link_image_inline() {
        assertEquals("<p>say <strong>hi</strong></p>", markdownToHtml("say **hi**"))
        assertEquals("<p>say <em>hi</em></p>", markdownToHtml("say _hi_"))
        assertEquals("<p><a href=\"https://x.io\">click</a></p>", markdownToHtml("[click](https://x.io)"))
        assertEquals("<p><img src=\"https://x.io/l.png\" alt=\"logo\"></p>", markdownToHtml("![logo](https://x.io/l.png)"))
    }

    @Test fun handlebars_vars_pass_through_untouched() {
        assertEquals("<p>Hi {{kinfolkName}}</p>", markdownToHtml("Hi {{kinfolkName}}"))
        assertEquals("<p><strong>{{kinfolkName}}</strong></p>", markdownToHtml("**{{kinfolkName}}**"))
    }

    @Test fun html_special_chars_are_escaped() {
        assertEquals("<p>a &lt; b &amp; c &gt; d</p>", markdownToHtml("a < b & c > d"))
    }

    @Test fun escaping_does_not_break_markdown_syntax() {
        assertEquals("<p><strong>a &lt; b</strong></p>", markdownToHtml("**a < b**"))
    }

    @Test fun wrapSelection_wraps_the_selected_range() {
        val r = wrapSelection("say hi there", 4, 6, "**", "**")
        assertEquals("say **hi** there", r.text)
        assertEquals(10, r.cursor)
    }

    @Test fun wrapSelection_no_selection_cursor_between_markers() {
        val r = wrapSelection("ab", 1, 1, "**", "**")
        assertEquals("a****b", r.text)
        assertEquals(3, r.cursor)
    }

    @Test fun insertSnippet_inserts_at_cursor() {
        val r = insertSnippet("Hi ", 3, "{{kinfolkName}}")
        assertEquals("Hi {{kinfolkName}}", r.text)
        assertEquals("Hi {{kinfolkName}}".length, r.cursor)
    }
}
