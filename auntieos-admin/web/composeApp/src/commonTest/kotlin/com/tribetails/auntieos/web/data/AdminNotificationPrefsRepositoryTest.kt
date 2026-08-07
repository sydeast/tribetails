package com.tribetails.auntieos.web.data

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Wire decode + encode contract for the admin's own notification receive-prefs.
 * Uses a fake `invoke` so the `{ prefs, updatedAtMs }` decode and the partial-channel
 * save payload are pinned without touching a live callable.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class AdminNotificationPrefsRepositoryTest {

    private val sampleGetJson = """
        {
          "prefs": {
            "byKey": { "invoice.new": { "email": true, "sms": false } },
            "byCategory": { "schedule": { "push": true } },
            "marketingOptIn": { "newsletter": true }
          },
          "updatedAtMs": 1717000000000
        }
    """.trimIndent()

    private fun repo(invoke: suspend (String, String) -> WriteResult<String>) =
        CloudAdminNotificationPrefsRepository(invoke)

    @Test
    fun decodesPrefsEnvelope() = runTest {
        val p = (repo { _, _ -> WriteResult.Ok(sampleGetJson) }.get() as WriteResult.Ok).value
        assertEquals(true, p.byKey["invoice.new"]?.email)
        assertEquals(false, p.byKey["invoice.new"]?.sms)
        assertNull(p.byKey["invoice.new"]?.push) // unset channel stays null (inherit default)
        assertEquals(true, p.byCategory["schedule"]?.push)
        assertEquals(true, p.marketingOptIn["newsletter"])
    }

    @Test
    fun missingPrefsDecodeToEmpty() = runTest {
        val p = (repo { _, _ -> WriteResult.Ok("""{ "updatedAtMs": null }""") }.get() as WriteResult.Ok).value
        assertTrue(p.byKey.isEmpty() && p.byCategory.isEmpty() && p.marketingOptIn.isEmpty())
    }

    @Test
    fun saveEmitsOnlySetChannelsAndPreservesOtherSections() = runTest {
        var sentName = ""
        var sentPayload = ""
        val r = repo { name, payload -> sentName = name; sentPayload = payload; WriteResult.Ok("{}") }
        val prefs = AdminNotificationPrefs(
            byKey = mapOf("invoice.new" to ChannelPrefs(email = false)),
            byCategory = mapOf("schedule" to ChannelPrefs(push = true)),
            marketingOptIn = mapOf("newsletter" to true),
        )
        assertTrue(r.save(prefs) is WriteResult.Ok)
        assertEquals("saveMyAdminNotificationPrefs", sentName)
        assertTrue(sentPayload.contains("\"prefs\""))
        assertTrue(sentPayload.contains("\"invoice.new\""))
        assertTrue(sentPayload.contains("\"email\":false"))
        assertFalse(sentPayload.contains("\"sms\"")) // unset channel is not emitted
        assertTrue(sentPayload.contains("\"byCategory\""))
        assertTrue(sentPayload.contains("\"marketingOptIn\""))
    }

    /**
     * The three TOP-LEVEL maps go out on every save, empty ones as `{}`.
     *
     * The server writes this payload with `mergeFields: ['notificationPrefs']`,
     * which replaces the WHOLE subtree, so a key this encoder omits is not left
     * alone on the server, it is DELETED. `encodePrefs` used to guard each map
     * with `isNotEmpty()`, which was harmless under the old `merge: true` and
     * erases whatever another device had put there under `mergeFields`.
     *
     * An all-empty prefs object is the ONLY input that catches this. Every
     * other save test here builds all three maps non-empty, so they pass
     * identically with the guards in or out.
     */
    @Test
    fun saveAlwaysEmitsAllThreeTopLevelMaps() = runTest {
        var sentPayload = ""
        val r = repo { _, payload -> sentPayload = payload; WriteResult.Ok("{}") }
        assertTrue(r.save(AdminNotificationPrefs()) is WriteResult.Ok)
        assertTrue(sentPayload.contains("\"byKey\":{}"), sentPayload)
        assertTrue(sentPayload.contains("\"byCategory\":{}"), sentPayload)
        assertTrue(sentPayload.contains("\"marketingOptIn\":{}"), sentPayload)
    }

    @Test
    fun getAndSaveForwardErrorsLoudly() = runTest {
        val errRepo = repo { _, _ -> WriteResult.Err("boom") }
        assertTrue(errRepo.get() is WriteResult.Err)
        assertTrue(errRepo.save(AdminNotificationPrefs()) is WriteResult.Err)
    }

    @Test
    fun withByKeyChannelPreservesOtherSectionsAndKeys() {
        val prefs = AdminNotificationPrefs(
            byKey = mapOf("a" to ChannelPrefs(email = true)),
            byCategory = mapOf("schedule" to ChannelPrefs(push = true)),
            marketingOptIn = mapOf("newsletter" to true),
        )
        val next = prefs.withByKeyChannel("b", "sms", true)
        assertEquals(true, next.byKey["a"]?.email) // existing key untouched
        assertEquals(true, next.byKey["b"]?.sms)   // new key added
        assertEquals(true, next.byCategory["schedule"]?.push) // category survives
        assertEquals(true, next.marketingOptIn["newsletter"]) // marketing survives
    }
}
