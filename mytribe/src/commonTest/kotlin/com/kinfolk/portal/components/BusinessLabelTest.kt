package com.kinfolk.portal.components

import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * #1381: household prose names the business from settings and says "your Auntie"
 * when it is unset. Never a hard-coded business.
 */
class BusinessLabelTest {
    @Test
    fun usesTheSettingsNameTrimmed() {
        assertEquals("Test Business", businessLabel("  Test Business "))
        assertEquals("Test Business", businessLabel("Test Business", capital = true))
    }

    @Test
    fun fallsBackToYourAuntieForUnsetBlankOrNull() {
        assertEquals("your Auntie", businessLabel(""))
        assertEquals("your Auntie", businessLabel("   "))
        assertEquals("your Auntie", businessLabel(null))
        assertEquals("your Auntie", BUSINESS_FALLBACK)
    }

    @Test
    fun capitalisesOnlyWhenTheLabelOpensASentence() {
        assertEquals("Your Auntie", businessLabel("", capital = true))
    }

    @Test
    fun formsThePossessiveForBothLabels() {
        assertEquals("your Auntie's", businessLabel("", possessive = true))
        assertEquals("Test Business's", businessLabel("Test Business", possessive = true))
    }

    @Test
    fun fillsEveryPlaceholderFormInTheStaticCatalog() {
        assertEquals(
            "News from Test Business. Test Business sends Test Business's news.",
            fillBusinessPlaceholders("News from {business}. {Business} sends {business's} news.", "Test Business"),
        )
        assertEquals(
            "From your Auntie. Your Auntie.",
            fillBusinessPlaceholders("From {business}. {Business}.", ""),
        )
        assertEquals("No placeholders here.", fillBusinessPlaceholders("No placeholders here.", "Test Business"))
    }
}
