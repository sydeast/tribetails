@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)
package com.kinfolk.portal.ui
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.screens.setThemedContent
import kotlin.test.Test
import kotlin.test.assertEquals
/** #1293: a launch link the app could not place lands on a real screen with a way back. */
class NotFoundScreenTest {
    @Test
    fun saysTheLinkLeadsNowhere_andBackToHomeClearsIt() = runComposeUiTest {
        var homeTaps = 0
        setThemedContent { NotFoundScreen(onHome = { homeTaps++ }) }
        waitForIdle()
        onNodeWithText(NOT_FOUND_TITLE).assertIsDisplayed()
        onNodeWithText(NOT_FOUND_BODY).assertIsDisplayed()
        onNodeWithText(NOT_FOUND_HOME).assertIsDisplayed().performClick()
        assertEquals(1, homeTaps)
    }
    @Test
    fun usesTheSameSentencesAsThePortalWebNotFoundPage() {
        assertEquals("We can’t find that page.", NOT_FOUND_TITLE)
        assertEquals("The link may be old, or the address may have a typo.", NOT_FOUND_BODY)
        assertEquals("Back to Home", NOT_FOUND_HOME)
    }
}
