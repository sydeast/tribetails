@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.auth

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.screens.setThemedContent
import kotlin.test.AfterTest
import kotlin.test.Test

class SignInScreenTest {

    private fun repo() = AuthRepository(FakeAuthBackend())

    @AfterTest
    fun tearDown() {
        SessionEndedNotice.clear()
    }

    @Test
    fun showsEyeToggle() = runComposeUiTest {
        setThemedContent {
            SignInScreen(repo = repo(), onSignedIn = {})
        }
        waitForIdle()
        // Hidden by default: the vector eye icon offers "show".
        onNodeWithContentDescription("Show password").assertIsDisplayed()
    }

    @Test
    fun tapEyeFlipsToHideIcon() = runComposeUiTest {
        setThemedContent {
            SignInScreen(repo = repo(), onSignedIn = {})
        }
        waitForIdle()
        onNodeWithContentDescription("Show password").performClick()
        waitForIdle()
        // After tapping, the field is visible so the icon offers "hide".
        onNodeWithContentDescription("Hide password").assertIsDisplayed()
        onNodeWithContentDescription("Show password").assertDoesNotExist()
    }

    /**
     * #1321 ruling, 2026-11-01: the app is MyTribe, and the business it is for is
     * named under it FROM SETTINGS (the public card), so a household knows it
     * has the right app. The headline never waits on that read.
     */
    @Test
    fun showsMyTribeBrandWithTheBusinessNameFromSettings() = runComposeUiTest {
        setThemedContent {
            SignInScreen(repo = repo(), onSignedIn = {}, businessName = "Sunny Paws")
        }
        waitForIdle()
        onNodeWithText("MyTribe").assertIsDisplayed()
        onNodeWithTag("business-byline").assertIsDisplayed()
        onNodeWithText("by Sunny Paws").assertIsDisplayed()
        onNodeWithText("by Tribe Tails Pet Care").assertDoesNotExist()
        onNodeWithText("Welcome back to your Tribe!").assertIsDisplayed()
    }

    /** No name set, or the card not read yet: the headline stands alone and no name is invented. */
    @Test
    fun omitsTheBusinessLineWhileNoNameIsKnown() = runComposeUiTest {
        setThemedContent {
            SignInScreen(repo = repo(), onSignedIn = {})
        }
        waitForIdle()
        onNodeWithText("MyTribe").assertIsDisplayed()
        onNodeWithTag("business-byline").assertDoesNotExist()
        onNodeWithText("by ", substring = true).assertDoesNotExist()
        onNodeWithText("Tribe Tails", substring = true).assertDoesNotExist()
    }

    @Test
    fun aBlankNameIsNoName() = runComposeUiTest {
        setThemedContent {
            SignInScreen(repo = repo(), onSignedIn = {}, businessName = "   ")
        }
        waitForIdle()
        onNodeWithTag("business-byline").assertDoesNotExist()
    }

    /**
     * #557. The sign-out that a revoked session triggers is not something the
     * kinfolk asked for, so this screen has to say why they are looking at it.
     */
    @Test
    fun explainsAnInvoluntarySignOut() = runComposeUiTest {
        SessionEndedNotice.record(SessionEndedReason.Revoked)
        setThemedContent {
            SignInScreen(repo = repo(), onSignedIn = {})
        }
        waitForIdle()
        onNodeWithTag("session-ended-notice").assertIsDisplayed()
        onNodeWithText(sessionEndedMessage(SessionEndedReason.Revoked)).assertIsDisplayed()
    }

    /** Docket Q1: an Auntie signed in to the portal and getMyAccess refused her. */
    @Test
    fun tellsAnAuntieThePortalIsForHouseholds() = runComposeUiTest {
        SessionEndedNotice.record(SessionEndedReason.Caretaker)
        setThemedContent {
            SignInScreen(repo = repo(), onSignedIn = {})
        }
        waitForIdle()
        onNodeWithTag("session-ended-notice").assertIsDisplayed()
        onNodeWithText("This sign-in is for households. Aunties use the AuntieOS app.").assertIsDisplayed()
    }

    @Test
    fun saysNothingOnAnOrdinaryVisit() = runComposeUiTest {
        SessionEndedNotice.clear()
        setThemedContent {
            SignInScreen(repo = repo(), onSignedIn = {})
        }
        waitForIdle()
        onNodeWithTag("session-ended-notice").assertDoesNotExist()
    }
}
