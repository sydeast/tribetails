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

    @Test
    fun showsMyTribeBrandWithTribeTailsTagline() = runComposeUiTest {
        setThemedContent {
            SignInScreen(repo = repo(), onSignedIn = {})
        }
        waitForIdle()
        // Product brand is MyTribe; the operating business is the tagline.
        onNodeWithText("MyTribe").assertIsDisplayed()
        onNodeWithText("by Tribe Tails Pet Care").assertIsDisplayed()
        onNodeWithText("Welcome back to your Tribe!").assertIsDisplayed()
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
