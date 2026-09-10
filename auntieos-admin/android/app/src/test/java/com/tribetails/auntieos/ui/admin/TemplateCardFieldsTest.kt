package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.repository.TemplateRepository
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The Template Bank card carries the same fields on both consoles.
 *
 * The list-shape rule (operator ruling 2026-08-06 "04 CARDS", written out in
 * `docs/2026-05-31-den-redesign-design.md`) is about what a browse-a-list
 * screen renders. On the web that came out as a card GRID; on a phone there is
 * one column either way, so Android's half of the rule is that the item is a
 * card carrying the fields the mock's card draws. Two of them,
 * `auntieos-template-bank-2026-05-27.html` l.235 "title, subject, description,
 * tags (max 4), category, key", were missing here: the Android row showed
 * title, subject, category and key, and dropped the description and the tags
 * the React screen had been showing all along.
 *
 * Pinned as pure functions because the Android suite is JVM only (no Compose
 * UI test runner), the same shape [templateBankSearchFilter] and
 * [templateBankChipLabel] already use.
 */
class TemplateCardFieldsTest {

    private fun tpl(
        description: String? = null,
        tags: List<String> = emptyList(),
        subject: String = "Your booking is confirmed",
    ) = TemplateRepository.EmailTemplate(
        templateId = "booking.confirmed",
        subject = subject,
        body = "Hi {{kinfolk_name}}",
        html = null,
        title = "Booking Confirmed",
        description = description,
        tags = tags,
        category = "Bookings",
    )

    // ── description ────────────────────────────────────────────────────────

    @Test
    fun description_isCarriedWhenThereIsOne() {
        assertEquals(
            "First touch after a kinfolk signs up.",
            templateCardDescription(tpl(description = "First touch after a kinfolk signs up.")),
        )
    }

    @Test
    fun description_isTrimmed() {
        assertEquals("Sets the tone.", templateCardDescription(tpl(description = "  Sets the tone.  ")))
    }

    /**
     * Null and whitespace both mean "no description", and the card must draw
     * nothing rather than an empty line: the same `description !== ''` guard
     * the React card uses.
     */
    @Test
    fun description_absentAndBlankBothRenderNothing() {
        assertNull(templateCardDescription(tpl(description = null)))
        assertNull(templateCardDescription(tpl(description = "")))
        assertNull(templateCardDescription(tpl(description = "   ")))
    }

    // ── tags ───────────────────────────────────────────────────────────────

    @Test
    fun tags_areCarriedInOrder() {
        assertEquals(
            listOf("welcome", "signup"),
            templateCardTags(tpl(tags = listOf("welcome", "signup"))),
        )
    }

    /**
     * Mock l.235: "tags (max 4)". Mirrors the web's `previewTags(tpl.tags, 4)`,
     * so a heavily tagged template does not blow the card's height out on
     * either console.
     */
    @Test
    fun tags_stopAtFour() {
        assertEquals(
            listOf("a", "b", "c", "d"),
            templateCardTags(tpl(tags = listOf("a", "b", "c", "d", "e", "f"))),
        )
    }

    @Test
    fun tags_noneIsAnEmptyList_notAPlaceholder() {
        assertEquals(emptyList<String>(), templateCardTags(tpl(tags = emptyList())))
    }

    // ── subject line ───────────────────────────────────────────────────────

    /** Mock l.256 draws "Subject: ..." on the card, and #716 marked its absence. */
    @Test
    fun subject_carriesTheMocksLabel() {
        assertEquals("Subject: Your booking is confirmed", templateCardSubjectLine(tpl()))
    }

    @Test
    fun subject_isTrimmedBeforeItIsLabelled() {
        assertEquals(
            "Subject: Your booking is confirmed",
            templateCardSubjectLine(tpl(subject = "  Your booking is confirmed  ")),
        )
    }

    /**
     * "Subject: No subject set" would label a sentence that is already about the
     * missing subject, so the fallback stays bare. Same rule as the React card.
     */
    @Test
    fun subject_missingKeepsTheBareFallback() {
        assertEquals("No subject set", templateCardSubjectLine(tpl(subject = "")))
        assertEquals("No subject set", templateCardSubjectLine(tpl(subject = "   ")))
    }
}
