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
