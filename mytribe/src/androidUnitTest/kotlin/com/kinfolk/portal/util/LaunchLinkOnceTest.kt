package com.kinfolk.portal.util

import android.net.Uri
import com.kinfolk.portal.screens.account.CardSetupReturn
import com.kinfolk.portal.screens.account.cardSetupReturnUrls
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * #2432: a claim, share or email link the app was opened with opens once.
 * #2427: the card setup's return address, read off a real `android.net.Uri`.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class LaunchLinkOnceTest {

    private fun openedEarlier() {
        androidInitialClaimInviteId = "invite-1"
        androidInitialShareToken = "share-1"
        androidInitialSecureResetParams = SecureResetParams(oobCode = "code-1")
        androidInitialUnknownLink = true
    }

    @After
    fun forgetEverything() {
        androidInitialClaimInviteId = null
        androidInitialShareToken = null
        androidInitialSecureResetParams = null
        androidInitialUnknownLink = false
    }

    private fun assertNothingWaiting() {
        assertNull(readInitialClaimInviteId())
        assertNull(readInitialShareToken())
        assertNull(readInitialSecureResetParams())
        assertFalse(readInitialUnknownLink())
    }

    /** Back closed the app, then the icon (or a tapped push) opened it again in the same run. */
    @Test
    fun aFreshStartForgetsTheLinkAnEarlierScreenWasOpenedWith_andReadsItsOwn() {
        openedEarlier()
        assertTrue(launchLinkShouldBeRead(restored = false, replayedFromHistory = false))
        assertNothingWaiting()
    }

    /** Android replays the task's first intent from Recents. That link opened the first time round. */
    @Test
    fun aFreshStartReplayedFromRecentsDoesNotReadTheLinkAgain() {
        openedEarlier()
        assertFalse(launchLinkShouldBeRead(restored = false, replayedFromHistory = true))
        assertNothingWaiting()
    }

    /** The same screen coming back (a configuration change): a household on the reset screen stays there. */
    @Test
    fun aRestoredScreenKeepsAndRereadsItsLink() {
        openedEarlier()
        assertTrue(launchLinkShouldBeRead(restored = true, replayedFromHistory = false))
        assertEquals("invite-1", readInitialClaimInviteId())
        assertEquals("share-1", readInitialShareToken())
        assertEquals(SecureResetParams(oobCode = "code-1"), readInitialSecureResetParams())
        assertTrue(readInitialUnknownLink())
    }

    @Test
    fun theCardSetupAddressesThisAppSendsStripeReadBack() {
        val (success, cancel) = cardSetupReturnUrls()
        assertEquals(CardSetupReturn(saved = true), cardSetupReturnOf(Uri.parse(success)))
        assertEquals(CardSetupReturn(saved = false), cardSetupReturnOf(Uri.parse(cancel)))
        assertEquals(CardSetupReturn(saved = true), cardSetupReturnOf(Uri.parse("mytribe://account?billing=saved")))
        assertEquals(CardSetupReturn(saved = false), cardSetupReturnOf(Uri.parse("mytribe://account")))
    }

    @Test
    fun otherLinksAreNotACardSetupReturn() {
        assertNull(cardSetupReturnOf(Uri.parse("https://kinfolk.tribetails.com/account?billing=saved")))
        assertNull(cardSetupReturnOf(Uri.parse("https://kinfolk.tribetails.com/app/account/x")))
        assertNull(cardSetupReturnOf(Uri.parse("https://kinfolk.tribetails.com/account/secure-reset?oobCode=x")))
        assertNull(cardSetupReturnOf(Uri.parse("https://evil.example/app/account?billing=saved")))
        assertNull(cardSetupReturnOf(Uri.parse("https://kinfolk.tribetails.com@evil.example/app/account")))
        assertNull(cardSetupReturnOf(Uri.parse("mytribe:account?billing=saved")))
        assertNull(cardSetupReturnOf(null))
    }
}
