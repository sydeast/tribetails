package com.tribetails.auntieos.ui.media

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import com.tribetails.auntieos.data.model.MediaFile
import com.tribetails.auntieos.data.model.MediaType
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Slice 9 Robolectric compose UI test for the media gallery cell (spec 28 items
 * 2/3). Renders the real [MediaThumbnail] and asserts the "Profile" badge + the
 * caption meta line ("YYYY-MM-DD · author") surface from real fields, the
 * placeholder "auntie" author drops to date-only, and a non-profile cell shows no
 * "Profile" badge.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class MediaCellRenderTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<ComponentActivity>()

    private fun media(profile: Boolean, at: String, by: String) = MediaFile(
        id = "m1",
        fileType = MediaType.IMAGE,
        isProfilePhoto = profile,
        uploadedAt = at,
        uploadedBy = by,
    )

    @Test
    fun `profile photo shows badge and real meta line`() {
        composeRule.setContent {
            AuntieOSTheme {
                MediaThumbnail(
                    mediaFile = media(profile = true, at = "2026-05-27T09:41:00Z", by = "jo@tribetails.com"),
                    onDelete = {},
                )
            }
        }
        composeRule.onNodeWithText("Profile").assertIsDisplayed()
        composeRule.onNodeWithText("2026-05-27 · jo@tribetails.com").assertIsDisplayed()
    }

    @Test
    fun `placeholder auntie author drops to date only`() {
        composeRule.setContent {
            AuntieOSTheme {
                MediaThumbnail(
                    mediaFile = media(profile = true, at = "2026-05-27", by = "auntie"),
                    onDelete = {},
                )
            }
        }
        composeRule.onNodeWithText("2026-05-27").assertIsDisplayed()
    }

    @Test
    fun `non profile cell shows no Profile badge`() {
        composeRule.setContent {
            AuntieOSTheme {
                MediaThumbnail(
                    mediaFile = media(profile = false, at = "2026-05-27", by = "jo@tribetails.com"),
                    onDelete = {},
                )
            }
        }
        // Negative: the "Profile" badge must be ABSENT on a non-profile cell.
        composeRule.onAllNodesWithText("Profile").assertCountEquals(0)
        composeRule.onNodeWithText("2026-05-27 · jo@tribetails.com").assertIsDisplayed()
    }
}
