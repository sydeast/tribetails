package com.tribetails.auntieos.ui.media

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
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
        entityType = MediaEntityType.KINFOLK.name,
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

    // `description` deliberately DIFFERENT from `originalFileName`: MediaThumbnail's
    // outer caption is `description.ifBlank { originalFileName }` (line ~373), so a
    // blank description would make the caption equal the filename too, and the
    // filename would already appear twice BEFORE any click (the in-tile label plus
    // the caption) — breaking the "1 node pre-click, 2 post-click" assertions below
    // before they ever exercise the fix.
    private fun docOrAudio(fileType: MediaType, name: String, description: String) = MediaFile(
        id = "f1",
        entityId = "kf1",
        entityType = MediaEntityType.KINFOLK.name,
        fileType = fileType,
        originalFileName = name,
        description = description,
    )

    /**
     * #388's Android-side gap: `MediaGalleryScreen.kt`'s DOCUMENT branch had no
     * `clickable` at all (unlike its IMAGE/VIDEO siblings, and despite
     * `FullscreenMediaViewer` already having a DOCUMENT/AUDIO branch ready to
     * receive it). Before the fix, tapping the in-tile filename did nothing and
     * this test would have failed on the second assertion (still one node, not
     * two). `FullscreenMediaViewer` renders its own copy of `originalFileName`
     * alongside the tile's, so the count going 1 -> 2 is the fullscreen viewer
     * actually opening, not just "did not crash".
     */
    @Test
    fun `document thumbnail opens the fullscreen viewer on tap`() {
        val file = docOrAudio(MediaType.DOCUMENT, name = "vet-notes.pdf", description = "Vet visit notes")
        composeRule.setContent {
            AuntieOSTheme {
                MediaThumbnail(mediaFile = file, onDelete = {})
            }
        }

        composeRule.onAllNodesWithText("vet-notes.pdf").assertCountEquals(1)
        composeRule.onNodeWithText("vet-notes.pdf").performClick()
        composeRule.waitForIdle()
        composeRule.onAllNodesWithText("vet-notes.pdf").assertCountEquals(2)
    }

    /** Same Android gap as the DOCUMENT case above, on the AUDIO branch. */
    @Test
    fun `audio thumbnail opens the fullscreen viewer on tap`() {
        val file = docOrAudio(MediaType.AUDIO, name = "voicemail.m4a", description = "Voicemail from the vet")
        composeRule.setContent {
            AuntieOSTheme {
                MediaThumbnail(mediaFile = file, onDelete = {})
            }
        }

        composeRule.onAllNodesWithText("voicemail.m4a").assertCountEquals(1)
        composeRule.onNodeWithText("voicemail.m4a").performClick()
        composeRule.waitForIdle()
        composeRule.onAllNodesWithText("voicemail.m4a").assertCountEquals(2)
    }
}
