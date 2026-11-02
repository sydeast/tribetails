@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.tribe

import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.firebase.FunctionsClient
import com.kinfolk.portal.portal.KinPhoto
import com.kinfolk.portal.portal.KinPhotosResult
import com.kinfolk.portal.portal.KinPortrait
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.screens.setThemedContent
import kotlinx.coroutines.CompletableDeferred
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * #1454 (operator ruling on #1295): "On Android/mobile web, the edit option
 * should only be under the account icon." The Tribe hub used to draw an Edit
 * Tribe Profile ghost button under its header at every width; it is gone, and
 * the account menu's entry (ShellNavTest pins it at slot two) is the way in.
 * The Home Information card keeps its own "Edit" link, which is that card's,
 * not one of the two entries the operator counted.
 *
 * #1463 (operator, 2026-11-02): the Gallery card is the household's media over
 * time, read from `getMyKinPhotos`, and always drawn. The KinTales section is
 * gone; it repeated the Tales tab.
 */
class TribeHubScreenTest {

    private fun photo(id: String, contentType: String = "image/jpeg") = buildJsonObject {
        put("id", id)
        put("url", "https://cdn/$id.jpg")
        put("contentType", contentType)
        put("taleId", "tale-$id")
        put("taleTitle", "Tale $id")
        put("takenAtMs", 1_700_000_000_000L)
    }

    private fun media(
        photoIds: List<Pair<String, String>> = emptyList(),
        portraitNames: List<String> = emptyList(),
        hasMore: Boolean = false,
    ): JsonObject = buildJsonObject {
        put("photos", buildJsonArray { photoIds.forEach { (id, type) -> add(photo(id, type)) } })
        put("portraits", buildJsonArray {
            portraitNames.forEachIndexed { i, n ->
                add(buildJsonObject {
                    put("kinId", "k$i")
                    put("kinName", n)
                    put("url", "https://cdn/$n-portrait.jpg")
                })
            }
        })
        put("hasMore", hasMore)
        if (hasMore) put("nextBefore", 1L) else put("nextBefore", JsonNull)
    }

    private fun FakeFunctionsClient.stubHub(photos: JsonObject = media()) {
        stub("getMyKin", buildJsonObject {
            put("kin", buildJsonArray {
                add(buildJsonObject {
                    put("id", "k1"); put("name", "Buddy"); put("status", "active")
                    put("photoUrl", "https://cdn/roster-only.jpg")
                })
            })
        })
        stub("getMyKinPhotos", photos)
        stub("getMyTribeProfile", buildJsonObject {
            put("profile", buildJsonObject {
                put("kinfolkId", "3")
                put("displayName", "The Foster")
                put("customFields", buildJsonArray {})
            })
            put("homeAccess", buildJsonObject {
                put("gateCode", "1234")
                put("keyLocation", JsonNull)
                put("wifiPassword", JsonNull)
                put("customFields", buildJsonArray {})
                put("updatedAtMs", JsonNull)
            })
        })
    }

    private fun ComposeUiTest.hub(client: FunctionsClient, onEditProfile: () -> Unit = {}, onOpenGallery: () -> Unit = {}) {
        setThemedContent {
            TribeHubScreen(
                familyName = "The Foster",
                kinfolkId = "3",
                portalApi = PortalApi(client),
                onEditProfile = onEditProfile,
                onOpenKinDetail = {},
                onManageKin = {},
                onOpenGallery = onOpenGallery,
            )
        }
    }

    @Test
    fun hub_hasNoEditTribeProfileButton() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stubHub()
        hub(fake)
        waitForIdle()
        onNodeWithText("Your Kin").assertIsDisplayed()
        onAllNodesWithText("Edit Tribe Profile").assertCountEquals(0)
    }

    @Test
    fun homeInformationCard_keepsItsOwnEditLink() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stubHub()
        var edits = 0
        hub(fake, onEditProfile = { edits += 1 })
        waitForIdle()
        onNodeWithText("Home Information").performScrollTo().assertIsDisplayed()
        onNodeWithText("Gate / door code on file", substring = true).performScrollTo().assertIsDisplayed()
        // The card's "Edit" is the only edit control left on the page.
        onAllNodesWithText("Edit").assertCountEquals(1)
        onNodeWithText("Edit").performScrollTo().performClick()
        waitForIdle()
        assertEquals(1, edits, "Home Information's Edit opens the Tribe Profile editor")
    }

    @Test
    fun galleryCard_isDrawnWithAnEmptyLineAndAllPhotos_whenThereIsNoMedia() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stubHub(media())
        var opened = 0
        hub(fake, onOpenGallery = { opened += 1 })
        waitForIdle()

        onNodeWithText("Gallery").performScrollTo().assertIsDisplayed()
        onNodeWithText("No photos yet.").performScrollTo().assertIsDisplayed()
        onAllNodesWithTag("tribeGalleryThumb").assertCountEquals(0)
        onNodeWithText("All photos").performScrollTo().performClick()
        waitForIdle()
        assertEquals(1, opened, "All photos opens the Gallery screen")
    }

    @Test
    fun galleryCard_doesNotClaimNoPhotos_whenOnlyTheNewestTalesLackThem() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stubHub(media(hasMore = true))
        hub(fake)
        waitForIdle()

        onNodeWithText("No recent photos. Older ones are in All photos.").performScrollTo().assertIsDisplayed()
        onAllNodesWithText("No photos yet.").assertCountEquals(0)
    }

    @Test
    fun galleryCard_drawsThumbnailsFromGetMyKinPhotos_mediaFirstThenPortraits() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stubHub(media(photoIds = listOf("m1" to "image/jpeg", "m2" to "video/mp4"), portraitNames = listOf("Biscuit")))
        hub(fake)
        waitForIdle()

        onAllNodesWithTag("tribeGalleryThumb").assertCountEquals(3)
        onNodeWithContentDescription("Tale m1").assertExists()
        onNodeWithContentDescription("Tale m2").assertExists()
        onNodeWithContentDescription("Biscuit").assertExists()
        onAllNodesWithText("No photos yet.").assertCountEquals(0)

        val call = fake.calls.single { it.first == "getMyKinPhotos" }
        assertEquals(GALLERY_CARD_PAGE, call.second?.get("limit")?.jsonPrimitive?.int)
        assertEquals("3", call.second?.get("kinfolkId")?.jsonPrimitive?.content)
    }

    @Test
    fun galleryCardThumbs_ordersMediaBeforePortraits_andCapsTheStrip() {
        val page = KinPhotosResult(
            photos = (0 until GALLERY_CARD_THUMBS + 3).map {
                KinPhoto("m$it", "https://cdn/m$it.jpg", "image/jpeg", "t-m$it", "Tale m$it", null)
            },
            portraits = listOf(KinPortrait("k1", "Biscuit", "https://cdn/b.jpg")),
            hasMore = false,
            nextBefore = null,
        )
        val thumbs = galleryCardThumbs(page)
        assertEquals(GALLERY_CARD_THUMBS, thumbs.size)
        assertEquals("Tale m0", thumbs.first().label)
        assertTrue(thumbs.none { it.label == "Biscuit" }, "portraits come after the media, so a full strip has none")

        val small = galleryCardThumbs(page.copy(photos = page.photos.take(1)))
        assertEquals(listOf("Tale m0", "Biscuit"), small.map { it.label })
    }

    @Test
    fun galleryCard_showsASpinnerWhileThePhotosLoad() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stubHub()
        val gate = CompletableDeferred<JsonObject>()
        val gated = object : FunctionsClient {
            override suspend fun call(name: String, payload: JsonObject?): JsonObject =
                if (name == "getMyKinPhotos") gate.await() else fake.call(name, payload)
        }
        hub(gated)
        waitForIdle()

        onNodeWithTag("tribeGalleryLoading").performScrollTo().assertIsDisplayed()
        onNodeWithText("All photos").performScrollTo().assertIsDisplayed()

        gate.complete(media())
        waitForIdle()
        onAllNodesWithTag("tribeGalleryLoading").assertCountEquals(0)
        onNodeWithText("No photos yet.").performScrollTo().assertIsDisplayed()
    }

    @Test
    fun hub_hasNoKinTalesSection_andNeverAsksForKinTales() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stubHub()
        hub(fake)
        waitForIdle()

        onNodeWithText("Gallery").performScrollTo().assertIsDisplayed()
        onAllNodesWithText("KinTales").assertCountEquals(0)
        onAllNodesWithText("All tales").assertCountEquals(0)
        assertTrue(fake.calls.none { it.first == "getMyKinTales" }, "the Tribe page no longer reads KinTales")
    }
}
