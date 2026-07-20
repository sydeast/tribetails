package com.tribetails.auntieos.web.ui.media

import androidx.compose.foundation.layout.width
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.runDesktopComposeUiTest
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.web.data.MediaFile
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import com.tribetails.auntieos.web.ui.components.AuntieMediaCell
import kotlin.test.Test

/**
 * Slice 9 desktop compose UI test for the media gallery cell (spec 28 items 2/3):
 * renders the real [AuntieMediaCell] with a caption and asserts the "Profile" badge
 * + the caption meta line ("YYYY-MM-DD · author") surface from real fields, the
 * placeholder "auntie" author drops out, and a non-profile cell shows no badge.
 */
@OptIn(ExperimentalTestApi::class)
class MediaCellRenderTest {

    private fun cell(media: MediaFile): @androidx.compose.runtime.Composable () -> Unit = {
        AuntieAppTheme(themeMode = ThemeMode.DARK) {
            AuntieMediaCell(media = media, showCaption = true, modifier = Modifier.width(200.dp))
        }
    }

    @Test
    fun profilePhoto_showsBadgeAndRealMetaLine() = runDesktopComposeUiTest {
        setContent {
            cell(
                MediaFile(
                    _id = "m1",
                    isProfilePhoto = true,
                    uploadedAt = "2026-05-27T09:41:00Z",
                    uploadedBy = "jo@tribetails.com",
                ),
            )()
        }
        onNodeWithText("Profile").assertIsDisplayed()
        onNodeWithText("2026-05-27 · jo@tribetails.com").assertIsDisplayed()
    }

    @Test
    fun placeholderAuntieAuthor_dropsToDateOnly() = runDesktopComposeUiTest {
        setContent {
            cell(
                MediaFile(
                    _id = "m2",
                    isProfilePhoto = true,
                    uploadedAt = "2026-05-27",
                    uploadedBy = "auntie",
                ),
            )()
        }
        onNodeWithText("2026-05-27").assertIsDisplayed()
    }

    @Test
    fun nonProfileCell_showsNoBadge() = runDesktopComposeUiTest {
        setContent {
            cell(
                MediaFile(
                    _id = "m3",
                    isProfilePhoto = false,
                    uploadedAt = "2026-05-27",
                    uploadedBy = "jo@tribetails.com",
                ),
            )()
        }
        // Negative: the "Profile" badge must be ABSENT on a non-profile cell.
        onAllNodesWithText("Profile").assertCountEquals(0)
        onNodeWithText("2026-05-27 · jo@tribetails.com").assertIsDisplayed()
    }
}
