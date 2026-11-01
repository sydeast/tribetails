package com.kinfolk.portal.util
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue
/** #1293: which launch links name something the app can open. Mirrors MainActivity.captureDeepLink. */
class DeepLinkRecognizedTest {
    @Test
    fun aClaimOrShareLinkWithAnIdIsRecognized() {
        assertTrue(deepLinkIsRecognized(listOf("claim", "inv1"), inviteQuery = null, isEmailAction = false))
        assertTrue(deepLinkIsRecognized(listOf("share", "tok"), inviteQuery = null, isEmailAction = false))
    }
    @Test
    fun aCustomSchemeLinkIsRecognizedOnceTheHostIsPrependedAsMainActivityDoes() {
        // mytribe://claim/inv1 -> host "claim", path ["inv1"].
        assertTrue(deepLinkIsRecognized(listOf("claim", "inv1"), inviteQuery = null, isEmailAction = false))
        assertFalse(deepLinkIsRecognized(listOf("inv1"), inviteQuery = null, isEmailAction = false))
    }
    @Test
    fun theQueryFormOfAnInviteLinkIsRecognized() {
        assertTrue(deepLinkIsRecognized(listOf("claim"), inviteQuery = "inv1", isEmailAction = false))
    }
    @Test
    fun anEmailActionLinkIsRecognized() {
        assertTrue(deepLinkIsRecognized(listOf("account", "secure-reset"), inviteQuery = null, isEmailAction = true))
    }
    @Test
    fun aClaimOrShareLinkWithNoIdIsNotRecognized() {
        assertFalse(deepLinkIsRecognized(listOf("claim"), inviteQuery = null, isEmailAction = false))
        assertFalse(deepLinkIsRecognized(listOf("claim"), inviteQuery = "  ", isEmailAction = false))
        assertFalse(deepLinkIsRecognized(listOf("share"), inviteQuery = null, isEmailAction = false))
        assertFalse(deepLinkIsRecognized(listOf("share", " "), inviteQuery = null, isEmailAction = false))
    }
    @Test
    fun anyOtherPathIsNotRecognized() {
        assertFalse(deepLinkIsRecognized(listOf("this-page-does-not-exist"), inviteQuery = null, isEmailAction = false))
        assertFalse(deepLinkIsRecognized(emptyList(), inviteQuery = null, isEmailAction = false))
    }
}
