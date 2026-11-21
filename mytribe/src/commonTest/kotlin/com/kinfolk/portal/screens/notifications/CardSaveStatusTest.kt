package com.kinfolk.portal.screens.notifications

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * #1904: a notification switch saved with nothing on screen near it to say
 * so. The card the tap was on now says what happened.
 */
class CardSaveStatusTest {
    @Test
    fun whileTheWriteIsOutItSaysSaving() {
        assertEquals("Saving…", cardSaveStatus(saving = true, saved = false, failed = false))
    }

    @Test
    fun aConfirmedWriteSaysSaved() {
        assertEquals("✓ Saved", cardSaveStatus(saving = false, saved = true, failed = false))
    }

    @Test
    fun aFailedWriteSaysNotSavedAndNeverSaved() {
        assertEquals(CARD_NOT_SAVED, cardSaveStatus(saving = false, saved = false, failed = true))
        assertEquals(CARD_NOT_SAVED, cardSaveStatus(saving = false, saved = true, failed = true))
    }

    @Test
    fun beforeAnyTapThereIsNothingToSay() {
        assertNull(cardSaveStatus(saving = false, saved = false, failed = false))
    }
}
