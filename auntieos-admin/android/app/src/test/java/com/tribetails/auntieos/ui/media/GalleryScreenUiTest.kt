package com.tribetails.auntieos.ui.media

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.tribetails.auntieos.data.model.MediaFile
import com.tribetails.auntieos.data.model.MediaType
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * [GalleryBody] against its mock (#755): the kit hero with the nav kicker and
 * the mock-shaped title, the upload action and the count chip in the hero,
 * one type tray with per-type counts, the mock's empty copy, and the mock's
 * delete X and confirm on a tile. Composed over a mocked repository, the
 * InvitesScreenUiTest precedent.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class GalleryScreenUiTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<ComponentActivity>()

    private fun repoReturning(rows: List<MediaFile>): AuntieRepository {
        val repo = mockk<AuntieRepository>()
        coEvery { repo.getAllMedia() } returns Result.success(rows)
        coEvery { repo.getAllKin() } returns Result.success(emptyList())
        coEvery { repo.getKinfolk() } returns Result.success(emptyList())
        return repo
    }

    private fun compose(repo: AuntieRepository, onUpload: () -> Unit = {}) {
        composeRule.setContent {
            AuntieOSTheme {
                GalleryBody(viewModel = GalleryViewModel(repository = repo), onUpload = onUpload)
            }
        }
        composeRule.waitForIdle()
    }

    @Test
    @Config(sdk = [35], qualifiers = "w1080dp-h2400dp-xhdpi")
    fun `draws the kit hero, the count chip, one type tray with counts, and a tile per row`() {
        compose(
            repoReturning(
                listOf(
                    MediaFile(id = "m1", fileType = MediaType.IMAGE, description = "Biscuit on the porch"),
                    MediaFile(id = "m2", fileType = MediaType.VIDEO, description = "Fetch in the backyard"),
                    MediaFile(id = "m3", fileType = MediaType.DOCUMENT, originalFileName = "vet-summary-biscuit.pdf"),
                ),
            ),
        )

        composeRule.onNodeWithText("THE DEN · GALLERY").assertIsDisplayed()
        composeRule.onNodeWithText("media").assertIsDisplayed()
        composeRule.onNodeWithText("Upload media").assertIsDisplayed()
        composeRule.onNodeWithText("3 files").assertIsDisplayed()
        // ONE tray, the mock's words with their counts, not three labelled rows.
        composeRule.onNodeWithText("All 3").assertIsDisplayed()
        composeRule.onNodeWithText("Images 1").assertIsDisplayed()
        composeRule.onNodeWithText("Videos 1").assertIsDisplayed()
        composeRule.onNodeWithText("Documents 1").assertIsDisplayed()
        for (label in listOf("HOUSEHOLD", "TYPE", "MONTH")) {
            assertEquals("no labelled chip row \"$label\"", 0, composeRule.onAllNodesWithText(label).fetchSemanticsNodes().size)
        }
        // The old explanation line is a tooltip now, never copy on the screen.
        assertEquals(
            0,
            composeRule.onAllNodesWithText("Tap a photo to tag the kin in it.", substring = true)
                .fetchSemanticsNodes().size,
        )
        // A document is the mock's file cell: its name in the tile at rest.
        composeRule.onNodeWithText("vet-summary-biscuit.pdf").assertIsDisplayed()
        // Every tile carries the mock's delete X.
        composeRule.onNodeWithContentDescription("Delete Biscuit on the porch").assertIsDisplayed()
        composeRule.onNodeWithContentDescription("Delete Fetch in the backyard").assertIsDisplayed()
        composeRule.onNodeWithContentDescription("Delete vet-summary-biscuit.pdf").assertIsDisplayed()
    }

    @Test
    fun `a proven-empty read draws the mock empty block with its two lines, and no chip`() {
        compose(repoReturning(emptyList()))

        composeRule.onNodeWithText("No media files found").assertIsDisplayed()
        composeRule.onNodeWithText("Upload photos and videos to see them here").assertIsDisplayed()
        // No chip stating "0 files" beside a block that already says so, and no tray of zeros.
        assertEquals(0, composeRule.onAllNodesWithText("0 files").fetchSemanticsNodes().size)
        assertEquals(0, composeRule.onAllNodesWithText("All 0").fetchSemanticsNodes().size)
    }

    @Test
    fun `a failed read shows the failure, never the empty block`() {
        val repo = mockk<AuntieRepository>()
        coEvery { repo.getAllMedia() } returns Result.failure(Exception("permission-denied"))
        coEvery { repo.getAllKin() } returns Result.success(emptyList())
        coEvery { repo.getKinfolk() } returns Result.success(emptyList())
        compose(repo)

        composeRule.onNodeWithText("permission-denied", substring = true).assertIsDisplayed()
        assertEquals(0, composeRule.onAllNodesWithText("No media files found").fetchSemanticsNodes().size)
    }

    @Test
    @Config(sdk = [35], qualifiers = "w1080dp-h2400dp-xhdpi")
    fun `the delete X asks for confirmation in the mock's words, and Cancel writes nothing`() {
        val repo = repoReturning(listOf(MediaFile(id = "v1", fileType = MediaType.VIDEO, description = "Walkies")))
        compose(repo)

        composeRule.onNodeWithContentDescription("Delete Walkies").performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Delete Media").assertIsDisplayed()
        composeRule.onNodeWithText("Are you sure you want to delete this video?").assertIsDisplayed()

        composeRule.onNodeWithText("Cancel").performClick()
        composeRule.waitForIdle()
        assertEquals(0, composeRule.onAllNodesWithText("Delete Media").fetchSemanticsNodes().size)
        coVerify(exactly = 0) { repo.deleteMediaFile(any(), any()) }
    }

    @Test
    @Config(sdk = [35], qualifiers = "w1080dp-h2400dp-xhdpi")
    fun `confirming deletes through the callable with no entity scope and the tile goes`() {
        val repo = repoReturning(listOf(MediaFile(id = "v1", entityId = "kf7", kinfolkId = "kf7", fileType = MediaType.VIDEO, description = "Walkies")))
        coEvery { repo.deleteMediaFile("v1", "") } returns Result.success(Unit)
        compose(repo)

        composeRule.onNodeWithContentDescription("Delete Walkies").performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Delete").performClick()
        composeRule.waitForIdle()

        coVerify(exactly = 1) { repo.deleteMediaFile("v1", "") }
        assertEquals(0, composeRule.onAllNodesWithContentDescription("Delete Walkies").fetchSemanticsNodes().size)
        composeRule.onNodeWithText("No media files found").assertIsDisplayed()
    }

    @Test
    fun `the hero upload action hands off to the caller`() {
        var uploads = 0
        compose(repoReturning(emptyList()), onUpload = { uploads++ })

        composeRule.onNodeWithText("Upload media").performClick()
        composeRule.waitForIdle()
        assertEquals(1, uploads)
    }
}
