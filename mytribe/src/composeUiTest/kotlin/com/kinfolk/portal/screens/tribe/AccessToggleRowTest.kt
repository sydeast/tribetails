@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.tribe

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.components.KIN_INFO_TIP_TAG
import com.kinfolk.portal.screens.setThemedContent
import kotlin.test.Test
import kotlin.test.assertTrue

/**
 * #829 review item 11: the Home access toggle explains what it grants behind an
 * info tip beside its label, the same sentence portal web shows on hover, and
 * never as a subtitle line under it.
 */
class AccessToggleRowTest {

    @Test
    fun homeAccessCarriesItsDescriptionBehindATipNotASubtitle() = runComposeUiTest {
        setThemedContent {
            AccessToggleRow(
                label = "Home access (gate code, Wi-Fi, Emergency Contacts)",
                value = false,
                onChange = {},
                description = HOME_ACCESS_DESCRIPTION,
            )
        }
        waitForIdle()
        onNodeWithText("Home access (gate code, Wi-Fi, Emergency Contacts)").assertIsDisplayed()
        onNodeWithTag(KIN_INFO_TIP_TAG).assertIsDisplayed()
        // The icon reads the sentence to TalkBack; the sentence is not drawn as a line of copy.
        onNodeWithContentDescription(HOME_ACCESS_DESCRIPTION).assertIsDisplayed()
        onNodeWithText(HOME_ACCESS_DESCRIPTION).assertDoesNotExist()
    }

    @Test
    fun aToggleWithNoDescriptionHasNoTip() = runComposeUiTest {
        setThemedContent { AccessToggleRow(label = "Can edit pets", value = true, onChange = {}) }
        waitForIdle()
        assertTrue(onAllNodesWithTag(KIN_INFO_TIP_TAG).fetchSemanticsNodes().isEmpty())
    }
}
