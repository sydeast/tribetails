package com.tribetails.auntieos.ui.media

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.tribetails.auntieos.data.model.MediaEntityType
import com.tribetails.auntieos.data.model.MediaFile
import com.tribetails.auntieos.data.model.MediaType
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Slice 7 UI test for the media cell "Set as profile photo" action:
 *  - a non-profile IMAGE cell shows the action and tapping it fires onSetProfile
 *    with the right MediaFile;
 *  - a cell already flagged isProfilePhoto shows the Profile badge and hides the
 *    set action (no double-set / no badge collision).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class MediaThumbnailUiTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<ComponentActivity>()

    private fun image(id: String, isProfile: Boolean) = MediaFile(
        id = id,
        entityId = "kf1",
        entityType = MediaEntityType.KINFOLK,
        fileType = MediaType.IMAGE,
        isProfilePhoto = isProfile,
    )

    @Test
    fun `non-profile image shows set action and tapping fires onSetProfile`() {
        var chosen: MediaFile? = null
        val file = image("m1", isProfile = false)
        composeRule.setContent {
            AuntieOSTheme {
                MediaThumbnail(mediaFile = file, onDelete = {}, onSetProfile = { chosen = it })
            }
        }

        composeRule.onNodeWithContentDescription("Set as profile photo").assertIsDisplayed()
        composeRule.onNodeWithContentDescription("Set as profile photo").performClick()
        composeRule.waitForIdle()
        assertEquals("m1", chosen?.id)
    }

    @Test
    fun `profile image shows the Profile badge and hides the set action`() {
        composeRule.setContent {
            AuntieOSTheme {
                MediaThumbnail(mediaFile = image("m2", isProfile = true), onDelete = {}, onSetProfile = {})
            }
        }

        composeRule.onNodeWithText("Profile").assertIsDisplayed()
        composeRule.onAllNodesWithContentDescription("Set as profile photo").assertCountEquals(0)
    }
}
