@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.auth

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.screens.setThemedContent
import kotlin.test.Test

class SignInScreenTest {

    private fun repo() = AuthRepository(FakeAuthBackend())

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
}
