package com.kinfolk.portal.screens.tribe

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** #873 second review: the page-save line for the profile and home access rate limit. */
class ProfileSaveFailureTest {

    @Test
    fun rateLimitIsRecognisedHoweverTheClientCarriesIt() {
        // Native Android SDK: the server's message.
        assertTrue(isRateLimited("Too many attempts. Try again later."))
        // Web-style code and the desktop REST body's status.
        assertTrue(isRateLimited("functions/resource-exhausted"))
        assertTrue(isRateLimited("Firebase REST call saveTribeProfile failed: HTTP 429 {\"status\":\"RESOURCE_EXHAUSTED\"}"))
        assertFalse(isRateLimited("permission-denied"))
        assertFalse(isRateLimited(null))
    }

    @Test
    fun aRateLimitGetsThePlainMessageAndAnythingElseKeepsItsOwn() {
        assertEquals(PROFILE_SAVE_RATE_LIMITED_MESSAGE, profileSaveFailureMessage(IllegalStateException("Too many attempts. Try again later.")))
        assertEquals("Save failed: nope", profileSaveFailureMessage(IllegalStateException("nope")))
        assertTrue(PROFILE_SAVE_RATE_LIMITED_MESSAGE.startsWith("Save failed"), "the status line colours a failure by this prefix")
    }
}
