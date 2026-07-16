@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.screens.setThemedContent
import kotlin.test.Test
import kotlin.test.assertTrue

class NoTribesOnboardingTest {

    @Test
    fun rendersWelcomeAndMessageAuntieCta() = runComposeUiTest {
        setThemedContent { NoTribesOnboarding() }
        waitForIdle()
        onNodeWithText("Welcome to MyTribe!").assertIsDisplayed()
        onNodeWithText("Message Auntie").assertIsDisplayed()
    }

    @Test
    fun messageAuntie_invokesCallback() = runComposeUiTest {
        var clicked = false
        setThemedContent {
            NoTribesOnboarding(onMessageAuntie = { clicked = true })
        }
        waitForIdle()
        onNodeWithText("Message Auntie").performClick()
        waitForIdle()
        assertTrue(clicked, "Message Auntie button should fire onMessageAuntie")
    }
}
