@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)
package com.kinfolk.portal.nav
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.screens.setThemedContent
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
/** #1369: the shell footer names the operator's business, never a hard-coded one. */
class AppFooterTest {
    @Test
    fun footer_namesTheBusinessFromSettings() = runComposeUiTest {
        setThemedContent { AppFooter("Paws and Claws Pet Sitting") }
        waitForIdle()
        onNodeWithText("Cared for by Paws and Claws Pet Sitting").assertIsDisplayed()
        onNodeWithText("Cared for by Tribe Tails Pet Care").assertDoesNotExist()
    }
    @Test
    fun footer_unsetName_drawsNothing() = runComposeUiTest {
        setThemedContent { AppFooter("   ") }
        waitForIdle()
        onNodeWithText("Cared for by", substring = true).assertDoesNotExist()
    }
    @Test
    fun footerText_trimsAndFallsBackToNull() {
        assertEquals("Cared for by Acme", appFooterText("  Acme "))
        assertNull(appFooterText(""))
    }
}
