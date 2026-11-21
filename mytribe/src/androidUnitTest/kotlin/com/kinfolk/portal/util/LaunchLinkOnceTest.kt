package com.kinfolk.portal.util

import android.content.Intent
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

    /**
     * A restored screen reads only its OWN intent. The link stored here was
     * another copy's (opened over Home, then closed with Back): a dark-mode
     * change rebuilding Home must not open it. A screen that was opened by a
     * link reads that link again from its own intent, which MainActivity does
     * when this answers true.
     */
    @Test
    fun aRestoredScreenForgetsAnotherScreensLink_andReadsItsOwnIntent() {
        openedEarlier()
        assertTrue(launchLinkShouldBeRead(restored = true, replayedFromHistory = false))
        assertNothingWaiting()
    }
    /** Replayed from Recents, then rebuilt by a configuration change: the replayed link stays unread. */
    @Test
    fun aRestoredScreenReplayedFromRecentsDoesNotReadTheLinkEither() {
        openedEarlier()
        assertFalse(launchLinkShouldBeRead(restored = true, replayedFromHistory = true))
        assertNothingWaiting()
    }

    // What MainActivity.onCreate does, driven with real intents.

    private fun launcherIntent(flags: Int = 0) = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER).addFlags(flags)
    private fun linkIntent(link: String, flags: Int = 0) = Intent(Intent.ACTION_VIEW, Uri.parse(link)).addFlags(flags)
    private val claimLink = "https://kinfolk.tribetails.com/claim/invite-9"
    private val resetLink = "https://kinfolk.tribetails.com/account/secure-reset?mode=resetPassword&oobCode=code-9"

    /** The issue's steps: a link opened earlier, Back, then the icon. Home, not the link. */
    @Test
    fun create_fromTheIcon_opensNoEarlierLink() {
        openedEarlier()
        readLaunchLinkOnCreate(launcherIntent(), restored = false)
        assertNothingWaiting()
    }

    @Test
    fun create_fromAClaimLink_opensThatClaim() {
        openedEarlier()
        readLaunchLinkOnCreate(linkIntent(claimLink), restored = false)
        assertEquals("invite-9", readInitialClaimInviteId())
        assertNull(readInitialShareToken())
        assertNull(readInitialSecureResetParams())
        assertFalse(readInitialUnknownLink())
    }

    @Test
    fun create_fromAResetLink_opensThatReset() {
        readLaunchLinkOnCreate(linkIntent(resetLink), restored = false)
        assertEquals("code-9", readInitialSecureResetParams()?.oobCode)
    }

    @Test
    fun create_replayedFromRecents_doesNotOpenTheTasksFirstLinkAgain() {
        readLaunchLinkOnCreate(linkIntent(claimLink, Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY), restored = false)
        assertNothingWaiting()
    }

    /** Dark mode or process death on the reset screen: the screen's own link is read again, so it stays. */
    @Test
    fun restoredCreate_onAScreenOpenedByALink_readsItsOwnLinkAgain() {
        readLaunchLinkOnCreate(linkIntent(resetLink), restored = true)
        assertEquals("code-9", readInitialSecureResetParams()?.oobCode)
    }

    /** Home rebuilt after a second copy of the app was opened by a link: that copy's link is not picked up. */
    @Test
    fun restoredCreate_ofAScreenOpenedFromTheIcon_opensNoOtherCopysLink() {
        openedEarlier()
        readLaunchLinkOnCreate(launcherIntent(), restored = true)
        assertNothingWaiting()
    }

    /** A link handed to the running screen (onNewIntent) is still read. */
    @Test
    fun newIntent_withAClaimLink_isRead() {
        captureLaunchLink(Uri.parse(claimLink))
        assertEquals("invite-9", readInitialClaimInviteId())
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
