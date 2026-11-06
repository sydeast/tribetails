package com.tribetails.auntieos.web.screens.admin
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
class RequiredFieldHintTest {
    @Test fun untouchedBlankSaysNothing() = assertNull(requiredFieldHint("Subject", "", touched = false))
    @Test fun touchedBlankNamesTheField() =
        assertEquals("Subject is required.", requiredFieldHint("Subject", "  ", touched = true))
    @Test fun fixedClears() = assertNull(requiredFieldHint("Subject", "Hi", touched = true))
}
