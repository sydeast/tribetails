package com.kinfolk.portal.portal

import com.kinfolk.portal.firebase.FakeFunctionsClient
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * `getMyKinPhotos` on the portal Android app (#469).
 *
 * The callable shipped with the web Gallery in PR #436; this client had no way
 * to call it, so the Tribe hub's "All photos" opened the KinTales feed instead.
 */
class GalleryPortalApiTest {

    private fun photo(id: String, url: String = "https://cdn/$id.jpg") = buildJsonObject {
        put("id", id)
        put("url", url)
        put("contentType", "image/jpeg")
        put("taleId", "tale-1")
        put("taleTitle", "Park Adventure")
        put("takenAtMs", 1_700_000_000_000L)
    }

    @Test
    fun `decodes a page of photos and the Kin portraits beside them`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyKinPhotos", buildJsonObject {
            put("photos", buildJsonArray { add(photo("m1")); add(photo("m2")) })
            put("portraits", buildJsonArray {
                add(buildJsonObject {
                    put("kinId", "k1")
                    put("kinName", "Buddy")
                    put("url", "https://cdn/buddy.jpg")
                })
            })
            put("hasMore", true)
            put("nextBefore", 1_699_000_000_000L)
        })

        val page = PortalApi(fake).getMyKinPhotos("fam-1")

        assertEquals(listOf("m1", "m2"), page.photos.map { it.id })
        assertEquals("Park Adventure", page.photos.first().taleTitle)
        assertEquals(1_700_000_000_000L, page.photos.first().takenAtMs)
        assertEquals(listOf("Buddy"), page.portraits.map { it.kinName })
        assertTrue(page.hasMore)
        assertEquals(1_699_000_000_000L, page.nextBefore)
    }

    @Test
    fun `forwards the page size and the cursor it was handed`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyKinPhotos", buildJsonObject {
            put("photos", buildJsonArray {})
            put("portraits", buildJsonArray {})
            put("hasMore", false)
            put("nextBefore", JsonNull)
        })

        PortalApi(fake).getMyKinPhotos(kinfolkId = "fam-1", limit = 12, before = 1_699_000_000_000L)

        val (name, payload) = fake.calls.single()
        assertEquals("getMyKinPhotos", name)
        assertEquals("fam-1", payload?.get("kinfolkId")?.toString()?.trim('"'))
        assertEquals("12", payload?.get("limit")?.toString())
        assertEquals("1699000000000", payload?.get("before")?.toString())
    }

    @Test
    fun `an empty archive decodes as no photos, not as a failure`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyKinPhotos", buildJsonObject {
            put("photos", buildJsonArray {})
            put("portraits", buildJsonArray {})
            put("hasMore", false)
            put("nextBefore", JsonNull)
        })

        val page = PortalApi(fake).getMyKinPhotos()

        assertTrue(page.photos.isEmpty())
        assertTrue(page.portraits.isEmpty())
        assertFalse(page.hasMore)
        assertNull(page.nextBefore)
        // No arguments at all means no payload, the same shape getMyKinTales
        // sends when it is asked for the default page.
        assertNull(fake.calls.single().second)
    }

    @Test
    fun `a photo with no url is skipped rather than drawn as a blank tile`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyKinPhotos", buildJsonObject {
            put("photos", buildJsonArray {
                add(photo("m1"))
                add(buildJsonObject { put("id", "m2") })
                add(buildJsonObject { put("id", "m3"); put("url", "") })
                add(buildJsonObject { put("url", "https://cdn/no-id.jpg") })
            })
            put("portraits", buildJsonArray {
                add(buildJsonObject { put("kinId", "k1"); put("kinName", "Buddy") })
            })
            put("hasMore", false)
            put("nextBefore", JsonNull)
        })

        val page = PortalApi(fake).getMyKinPhotos()

        assertEquals(listOf("m1"), page.photos.map { it.id })
        assertTrue(page.portraits.isEmpty())
    }

    @Test
    fun `a photo with no content type still counts as an image`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyKinPhotos", buildJsonObject {
            put("photos", buildJsonArray {
                add(buildJsonObject { put("id", "m1"); put("url", "https://cdn/m1.jpg") })
                add(buildJsonObject {
                    put("id", "m2")
                    put("url", "https://cdn/m2.mp4")
                    put("contentType", "video/mp4")
                })
            })
            put("portraits", buildJsonArray {})
            put("hasMore", false)
            put("nextBefore", JsonNull)
        })

        val page = PortalApi(fake).getMyKinPhotos()

        assertNull(page.photos[0].contentType)
        assertTrue(page.photos[0].isImage())
        assertFalse(page.photos[1].isImage())
    }

    @Test
    fun `an older deployed callable that sends nothing decodes as an empty page`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyKinPhotos", buildJsonObject {})

        val page = PortalApi(fake).getMyKinPhotos()

        assertTrue(page.photos.isEmpty())
        assertTrue(page.portraits.isEmpty())
        assertFalse(page.hasMore)
        assertNull(page.nextBefore)
    }

    @Test
    fun `a refusal surfaces rather than reading as an empty gallery`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stubError("getMyKinPhotos", IllegalStateException("permission-denied"))
        assertFailsWith<IllegalStateException> { PortalApi(fake).getMyKinPhotos("someone-elses-family") }
    }
}
