@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.screens.setThemedContent
import kotlin.test.Test

class LaunchErrorScreenTest {

    private val reassurance =
        "Nothing is lost, your pack is safe. Give it another try in a moment."

    @Test
    fun reassurance_always_shown() = runComposeUiTest {
        setThemedContent {
            LaunchErrorScreen(message = "Network unavailable.", onRetry = {}, onSignOut = {})
        }
        waitForIdle()
        onNodeWithText(reassurance).assertIsDisplayed()
    }
}
