package com.tribetails.auntieos.ui.admin

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

/**
 * #1883: the notification details box spoke the data model's language ("the
 * recipient rule above resolves to", "Update MyTribe functions"). These are the
 * lines the owner reads under WHAT THE BODY CAN CARRY and WHO RECEIVES IT.
 */
class NotifGateDetailWordsTest {
    private val developer = Regex("recipient rule|resolves to|therefore|functions", RegexOption.IGNORE_CASE)

    @Test fun bodyLineNamesWhoCanReadItInPlainWords() {
        val line = notifBodyCarryLine(listOf("Amount", "Due date"))
        assertEquals(
            "Anything here can appear in the message, so everyone who gets this notice can read it: Amount, Due date",
            line,
        )
        assertFalse(developer.containsMatchIn(line))
    }

    @Test fun missingRecipientsLineHasNoDeveloperWording() {
        assertFalse(developer.containsMatchIn(NOTIF_NO_RECIPIENTS_LINE))
    }
}
