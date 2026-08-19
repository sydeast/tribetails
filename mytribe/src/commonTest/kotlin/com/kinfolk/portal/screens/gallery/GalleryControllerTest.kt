package com.kinfolk.portal.screens.gallery

import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.portal.PortalApi
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Gallery state: what loads, what appends, and what each failure does (#469). */
class GalleryControllerTest {

    private fun photo(id: String) = buildJsonObject {
        put("id", id)
        put("url", "https://cdn/$id.jpg")
        put("contentType", "image/jpeg")
        put("taleId", "tale-$id")
        put("taleTitle", "Tale $id")
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

    @Test
    fun `reload loads the first page and its portraits`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyKinPhotos", page(listOf("m1", "m2"), portraitNames = listOf("Buddy")))
        val c = GalleryController("fam-1", PortalApi(fake), this)

        c.reload()

        assertEquals(listOf("m1", "m2"), c.photos?.map { it.id })
        assertEquals(listOf("Buddy"), c.portraits.map { it.kinName })
        assertFalse(c.hasMore)
        assertNull(c.loadError)
        assertFalse(c.accessDenied)
    }

    @Test
    fun `an archive with no photos loads as empty, which is not an error`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyKinPhotos", page(emptyList()))
        val c = GalleryController("fam-1", PortalApi(fake), this)

        c.reload()

        assertEquals(emptyList(), c.photos)
        assertTrue(c.portraits.isEmpty())
        assertNull(c.loadError)
        assertFalse(c.accessDenied)
    }

    @Test
    fun `a failed first page sets the error and leaves nothing to draw`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stubError("getMyKinPhotos", IllegalStateException("gallery is down"))
        val c = GalleryController("fam-1", PortalApi(fake), this)

        c.reload()

        assertNull(c.photos)
        assertEquals("gallery is down", c.loadError)
        assertFalse(c.accessDenied)
    }

    @Test
    fun `a refusal is its own state, not one more couldn't-load line`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stubError("getMyKinPhotos", IllegalStateException("permission-denied: not your family"))
        val c = GalleryController("fam-1", PortalApi(fake), this)

        c.reload()

        assertTrue(c.accessDenied)
        assertNull(c.loadError)
        assertNull(c.photos)
    }

    @Test
    fun `a retry that succeeds clears both failure states`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stubError("getMyKinPhotos", IllegalStateException("permission-denied"))
        val c = GalleryController("fam-1", PortalApi(fake), this)
        c.reload()
        assertTrue(c.accessDenied)

        fake.stub("getMyKinPhotos", page(listOf("m1")))
        c.reload()

        assertFalse(c.accessDenied)
        assertNull(c.loadError)
        assertEquals(listOf("m1"), c.photos?.map { it.id })
    }

    @Test
    fun `hasMore stays false when the server offers no cursor to page with`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyKinPhotos", page(listOf("m1"), hasMore = true, nextBefore = null))
        val c = GalleryController("fam-1", PortalApi(fake), this)

        c.reload()

        assertFalse(c.hasMore)
    }

    @Test
    fun `loadMore appends the older page and asks with the cursor it was given`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyKinPhotos", page(listOf("m1", "m2"), hasMore = true, nextBefore = 1_699_000_000_000L))
        val c = GalleryController("fam-1", PortalApi(fake), this)
        c.reload()

        fake.stub("getMyKinPhotos", page(listOf("m3")))
        c.loadMore()
        advanceUntilIdle()

        assertEquals(listOf("m1", "m2", "m3"), c.photos?.map { it.id })
        assertFalse(c.hasMore)
        assertNull(c.moreError)
        assertEquals("1699000000000", fake.calls.last().second?.get("before")?.toString())
    }

    @Test
    fun `a photo already on screen is not appended a second time`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyKinPhotos", page(listOf("m1", "m2"), hasMore = true, nextBefore = 1_699_000_000_000L))
        val c = GalleryController("fam-1", PortalApi(fake), this)
        c.reload()

        // The same media file attached to a tale on each page.
        fake.stub("getMyKinPhotos", page(listOf("m2", "m3")))
        c.loadMore()
        advanceUntilIdle()

        assertEquals(listOf("m1", "m2", "m3"), c.photos?.map { it.id })
    }

    @Test
    fun `loadMore does nothing when there is nothing older`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyKinPhotos", page(listOf("m1")))
        val c = GalleryController("fam-1", PortalApi(fake), this)
        c.reload()

        c.loadMore()
        advanceUntilIdle()

        assertEquals(1, fake.calls.size)
    }

    @Test
    fun `a failed older page keeps the photos already on screen`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyKinPhotos", page(listOf("m1", "m2"), hasMore = true, nextBefore = 1_699_000_000_000L))
        val c = GalleryController("fam-1", PortalApi(fake), this)
        c.reload()

        fake.stubError("getMyKinPhotos", IllegalStateException("older photos unavailable"))
        c.loadMore()
        advanceUntilIdle()

        assertEquals("older photos unavailable", c.moreError)
        assertEquals(listOf("m1", "m2"), c.photos?.map { it.id })
        assertNull(c.loadError)
        // Still offered, so the household can try the same page again.
        assertTrue(c.hasMore)
    }

    @Test
    fun `portraits are not repeated under every older page`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub(
            "getMyKinPhotos",
            page(listOf("m1"), portraitNames = listOf("Buddy"), hasMore = true, nextBefore = 1_699_000_000_000L),
        )
        val c = GalleryController("fam-1", PortalApi(fake), this)
        c.reload()

        fake.stub("getMyKinPhotos", page(listOf("m2")))
        c.loadMore()
        advanceUntilIdle()

        assertEquals(listOf("Buddy"), c.portraits.map { it.kinName })
    }

    @Test
    fun `the viewer opens on the photo it was handed and closes again`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyKinPhotos", page(listOf("m1", "m2")))
        val c = GalleryController("fam-1", PortalApi(fake), this)
        c.reload()
        assertNull(c.viewing)

        c.openViewer(c.photos!![1])
        assertEquals("m2", c.viewing?.id)

        c.closeViewer()
        assertNull(c.viewing)
    }

    @Test
    fun `isPermissionDenied reads a refusal and nothing else`() {
        assertTrue(isPermissionDenied("permission-denied"))
        assertTrue(isPermissionDenied("FUNCTIONS PERMISSION_DENIED: not a member"))
        assertFalse(isPermissionDenied("unavailable"))
        assertFalse(isPermissionDenied(null))
    }
}
