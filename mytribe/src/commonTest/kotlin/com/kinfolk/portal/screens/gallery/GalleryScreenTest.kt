@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.gallery

import androidx.compose.runtime.Composable
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.screens.setThemedContent
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals

/** What a household actually sees on the Gallery screen (#469). */
class GalleryScreenTest {

    private fun photo(id: String, title: String = "Park Adventure", contentType: String? = "image/jpeg") =
        buildJsonObject {
            put("id", id)
            put("url", "https://cdn/$id.jpg")
            contentType?.let { put("contentType", it) }
            put("taleId", "tale-$id")
            put("taleTitle", title)
            put("takenAtMs", 1_700_000_000_000L)
        }

    private fun page(
        ids: List<String>,
        portraitNames: List<String> = emptyList(),
        hasMore: Boolean = false,
        nextBefore: Long? = null,
    ): JsonObject = buildJsonObject {
        put("photos", buildJsonArray { ids.forEach { add(photo(it)) } })
        put("portraits", buildJsonArray {
            portraitNames.forEachIndexed { i, n ->
                add(buildJsonObject {
                    put("kinId", "k$i")
                    put("kinName", n)
                    put("url", "https://cdn/$n.jpg")
                })
            }
        })
        put("hasMore", hasMore)
        if (nextBefore == null) put("nextBefore", JsonNull) else put("nextBefore", nextBefore)
    }

    @Composable
    private fun Screen(fake: FakeFunctionsClient) {
        GalleryScreen(
            kinfolkId = "fam-1",
            portalApi = PortalApi(fake),
            onBack = {},
            onOpenKinDetail = {},
            onOpenKinTales = {},
        )
    }

    @Test
    fun rendersPhotoTilesAndTheirCaptions() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyKinPhotos", page(listOf("m1", "m2", "m3", "m4")))

        setThemedContent { Screen(fake) }
        waitForIdle()

        onNodeWithText("The Gallery").assertIsDisplayed()
        onNodeWithText("From your KinTales").assertIsDisplayed()
        assertEquals(4, onAllNodesWithTag("galleryTile").fetchSemanticsNodes().size)
    }

    @Test
    fun emptyArchive_saysSoInsteadOfShowingAnEmptyGrid() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyKinPhotos", page(emptyList()))

        setThemedContent { Screen(fake) }
        waitForIdle()

        onNodeWithText("No photos yet. Every KinTale your Auntie sends brings its pictures here.").assertIsDisplayed()
        assertEquals(0, onAllNodesWithTag("galleryTile").fetchSemanticsNodes().size)
    }

    @Test
    fun loadFailure_showsTheServersOwnMessage() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stubError("getMyKinPhotos", IllegalStateException("gallery is down"))

        setThemedContent { Screen(fake) }
        waitForIdle()

        onNodeWithText("gallery is down").assertIsDisplayed()
    }

    @Test
    fun refusal_readsAsARefusalRatherThanAFailureToRetry() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stubError("getMyKinPhotos", IllegalStateException("permission-denied"))

        setThemedContent { Screen(fake) }
        waitForIdle()

        onNodeWithText("Your account doesn't have access to these photos. Message your Auntie if that looks wrong.")
            .assertIsDisplayed()
    }

    @Test
    fun portraitsCard_showsOnlyWhenTheRosterHasFaces() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyKinPhotos", page(listOf("m1"), portraitNames = listOf("Buddy")))

        setThemedContent { Screen(fake) }
        waitForIdle()

        onNodeWithText("Your Kin").assertIsDisplayed()
        onNodeWithText("Buddy").assertIsDisplayed()
    }

    @Test
    fun noPortraits_hidesThatCardEntirely() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyKinPhotos", page(listOf("m1")))

        setThemedContent { Screen(fake) }
        waitForIdle()

        onNodeWithText("Your Kin").assertDoesNotExist()
    }

    @Test
    fun olderPhotos_offeredOnlyWhenThereAreSome_andAppendOnTap() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyKinPhotos", page(listOf("m1"), hasMore = true, nextBefore = 1_699_000_000_000L))

        setThemedContent { Screen(fake) }
        waitForIdle()
        assertEquals(1, onAllNodesWithTag("galleryTile").fetchSemanticsNodes().size)

        fake.stub("getMyKinPhotos", page(listOf("m2")))
        onNodeWithText("Show older photos").performClick()
        waitForIdle()

        assertEquals(2, onAllNodesWithTag("galleryTile").fetchSemanticsNodes().size)
        onNodeWithText("Show older photos").assertDoesNotExist()
    }

    @Test
    fun lastPage_neverOffersOlderPhotos() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyKinPhotos", page(listOf("m1")))

        setThemedContent { Screen(fake) }
        waitForIdle()

        onNodeWithText("Show older photos").assertDoesNotExist()
    }

    @Test
    fun olderPageFailure_keepsThePhotosAlreadyOnScreen() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyKinPhotos", page(listOf("m1"), hasMore = true, nextBefore = 1_699_000_000_000L))

        setThemedContent { Screen(fake) }
        waitForIdle()

        fake.stubError("getMyKinPhotos", IllegalStateException("older photos unavailable"))
        onNodeWithText("Show older photos").performClick()
        waitForIdle()

        onNodeWithText("older photos unavailable").assertIsDisplayed()
        assertEquals(1, onAllNodesWithTag("galleryTile").fetchSemanticsNodes().size)
    }

    @Test
    fun tappingATile_opensTheViewerOnThatPhoto() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyKinPhotos", page(listOf("m1")))

        setThemedContent { Screen(fake) }
        waitForIdle()

        onAllNodesWithTag("galleryTile")[0].performClick()
        waitForIdle()

        onNodeWithContentDescription("Close photo").assertExists()
    }

    @Test
    fun aVideoTile_saysItIsAVideoInsteadOfShowingAFailedImage() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyKinPhotos", buildJsonObject {
            put("photos", buildJsonArray { add(photo("m1", contentType = "video/mp4")) })
            put("portraits", buildJsonArray {})
            put("hasMore", false)
            put("nextBefore", JsonNull)
        })

        setThemedContent { Screen(fake) }
        waitForIdle()

        onAllNodesWithTag("galleryTile")[0].performClick()
        waitForIdle()

        onNodeWithText("This one is a video. Open its KinTale to play it.").assertIsDisplayed()
    }
}
