package com.kinfolk.portal.portal
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
/** #1277: the household never sees a backend setting name. */
class InviteFailureTest {
    @Test
    fun aConfigRefusalIsCaught_withAndWithoutTheStatusSuffix() {
        assertTrue(isConfigGapError(IllegalStateException("AUNTIE_OS_REVIEW_BASE_URL is not configured [400]")))
        assertTrue(isConfigGapError(RuntimeException("CLAIM_LINK_BASE_URL is not configured")))
        assertEquals(INVITES_UNAVAILABLE_MESSAGE, inviteFailureLine(RuntimeException("CLAIM_LINK_BASE_URL is not configured")))
    }
    @Test
    fun refusalsTheHouseholdCanActOnAreShownAsBefore() {
        assertFalse(isConfigGapError(IllegalStateException("You cannot invite yourself.")))
        assertFalse(isConfigGapError(IllegalStateException("Your email is not configured")))
        assertFalse(isConfigGapError(IllegalStateException()))
        assertEquals("Invite failed: You cannot invite yourself.", inviteFailureLine(IllegalStateException("You cannot invite yourself.")))
    }
    @Test
    fun thePlainLineNamesNoSetting() {
        assertFalse(Regex("[A-Z]{2,}_[A-Z]").containsMatchIn(INVITES_UNAVAILABLE_MESSAGE))
        assertEquals("Invites can't be sent right now. It's been reported to Auntie.", INVITES_UNAVAILABLE_MESSAGE)
    }
}
