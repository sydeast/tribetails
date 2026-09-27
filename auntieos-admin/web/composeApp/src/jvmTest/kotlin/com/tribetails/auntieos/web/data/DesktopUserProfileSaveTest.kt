package com.tribetails.auntieos.web.data

import com.sun.net.httpserver.HttpServer
import com.tribetails.auntieos.web.screens.settings.ProfileLoad
import com.tribetails.auntieos.web.screens.settings.SavedProfile
import com.tribetails.auntieos.web.screens.settings.baseline
import com.tribetails.auntieos.web.screens.settings.effectiveProfileLoad
import com.tribetails.auntieos.web.screens.settings.isLoaded
import com.tribetails.auntieos.web.screens.settings.nextProfileLoad
import com.tribetails.auntieos.web.screens.settings.profileFormChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import java.net.InetSocketAddress
import java.net.URLDecoder
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #897: desktop Settings, a failed profile load followed by Save overwrote
 * `users/{uid}` with blanks.
 *
 * Two things were wrong. The screens folded "loading", "failed" and "no
 * document" into one null, so after a failed read the form was blank and Save
 * was live. And the save PATCHed the whole model with no updateMask, which
 * replaced the document: blanks over name and phone, and every field the model
 * does not carry deleted.
 *
 * A local HTTP server stands in for Firestore REST (the #857 pattern): it serves
 * typed documents on GET, can be told to fail reads, and records every write with
 * its updateMask, so each test asserts exactly what the desktop sent.
 */
class DesktopUserProfileSaveTest {

    private data class Write(val method: String, val path: String, val mask: List<String>, val fields: JsonObject)

    private lateinit var server: HttpServer
    private val docs = mutableMapOf<String, JsonObject>()
    private val writes = mutableListOf<Write>()
    @Volatile private var failReads = false

    @BeforeTest
    fun setUp() {
        JvmFirestoreRest.clearTimestampPaths()
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { ex ->
            val path = ex.requestURI.rawPath.substringAfter("/documents")
            val body = ex.requestBody.readBytes().decodeToString()
            val (status, out) = when {
                ex.requestMethod == "GET" && failReads -> 503 to """{"error":{"message":"unavailable"}}"""
                ex.requestMethod == "GET" -> {
                    val rel = path.removePrefix("/")
                    val doc = docs[rel]
                    when {
                        doc != null -> 200 to doc.toString()
                        else -> 200 to buildJsonObject {
                            put("documents", buildJsonArray { docs.filterKeys { it.substringBeforeLast('/') == rel }.values.forEach { add(it) } })
                        }.toString()
                    }
                }
                else -> {
                    val mask = ex.requestURI.rawQuery.orEmpty().split('&')
                        .filter { it.startsWith("updateMask.fieldPaths=") }
                        .map { URLDecoder.decode(it.substringAfter('='), "UTF-8") }
                    synchronized(writes) {
                        writes += Write(ex.requestMethod, path, mask, Json.parseToJsonElement(body).jsonObject["fields"]!!.jsonObject)
                    }
                    200 to "{}"
                }
            }
            val bytes = out.encodeToByteArray()
            ex.sendResponseHeaders(status, bytes.size.toLong())
            ex.responseBody.use { it.write(bytes) }
        }
        server.start()
        JvmFirestoreFixtures.restTransport = RestTestTransport(
            http = auntieHttpClient(requestTimeoutMs = 5_000),
            base = "http://127.0.0.1:${server.address.port}/v1/projects/p/databases/(default)/documents",
            token = "test-token",
        )
    }

    @AfterTest
    fun tearDown() {
        JvmFirestoreFixtures.clear()
        JvmFirestoreRest.clearTimestampPaths()
        server.stop(0)
    }

    private fun ts(iso: String) = buildJsonObject { put("timestampValue", iso) }
    private fun str(s: String) = buildJsonObject { put("stringValue", s) }

    /** The operator's profile as the live document holds it, with a field the model does not carry. */
    private fun seedOperator() {
        docs["users/u1"] = buildJsonObject {
            put("name", "projects/p/databases/(default)/documents/users/u1")
            put("fields", buildJsonObject {
                put("uid", str("u1"))
                put("email", str("op@example.com"))
                put("displayName", str("Syd"))
                put("firstName", str("Syd"))
                put("lastName", str("East"))
                put("phone", str("555-0100"))
                put("title", str("Owner"))
                put("themeMode", str("DARK"))
                put("staffRole", str("admin"))
                put("createdAt", ts("2024-01-02T03:04:05Z"))
                put("updatedAt", ts("2025-06-07T08:09:10.123456Z"))
            })
        }
    }

    private suspend fun loadOperator(): ProfileLoad {
        val first = platformUserProfileStream("u1").first()
        return nextProfileLoad(ProfileLoad.Loading, first)
    }

    // ── a failed load blocks Save ──────────────────────────────────────────

    @Test
    fun aFailedFirstReadIsFailedNotAnEmptyProfile() = runBlocking {
        seedOperator()
        failReads = true
        val load = loadOperator()

        assertIs<ProfileLoad.Failed>(load, "a failed read must not read as 'no profile'")
        assertFalse(load.isLoaded, "Save is gated on isLoaded")
        assertNull(load.baseline, "nothing to diff a save against")
        assertTrue(writes.isEmpty(), "reading wrote nothing")
    }

    @Test
    fun aPollThatFailsAfterAGoodReadKeepsTheLoadedProfile() = runBlocking {
        seedOperator()
        val loaded = loadOperator()
        assertIs<ProfileLoad.Loaded>(loaded)

        failReads = true
        val afterFailedPoll = nextProfileLoad(loaded, platformUserProfileStream("u1").first())
        assertEquals(loaded, afterFailedPoll, "one failed poll must not blank the form")
        assertEquals(loaded, nextProfileLoad(loaded, FirestoreResult.Loading))
    }

    @Test
    fun retryAfterAFailureShowsLoadingThenTheProfile() {
        val failed = nextProfileLoad(ProfileLoad.Loading, FirestoreResult.Error("unavailable"))
        assertIs<ProfileLoad.Failed>(failed)
        assertEquals(ProfileLoad.Loading, nextProfileLoad(failed, FirestoreResult.Loading))
        assertEquals(ProfileLoad.Loaded(null), nextProfileLoad(failed, FirestoreResult.Data(null)), "a missing document is Loaded(null), not Failed")
    }

    // ── a save after a load sends only the changed fields ───────────────────

    @Test
    fun aSaveAfterALoadSendsOnlyTheChangedFieldWithAMask() = runBlocking {
        seedOperator()
        val loaded = loadOperator().baseline!!
        assertEquals("555-0100", loaded.phone)

        assertEquals(WriteResult.Ok(Unit), platformUpdateUserProfile("u1", loaded, loaded.copy(phone = "555-0199")))

        val w = writes.single()
        assertEquals("PATCH /users/u1", "${w.method} ${w.path}")
        assertEquals(setOf("phone", "updatedAt"), w.mask.toSet(), "the mask names the edit and its stamp, nothing else")
        assertEquals(setOf("phone", "updatedAt"), w.fields.keys, "the body carries nothing the mask does not name")
        assertEquals(str("555-0199"), w.fields["phone"])
    }

    @Test
    fun theStampGoesBackAsATimestampAndCreatedAtIsNotTouched() = runBlocking {
        seedOperator()
        val loaded = loadOperator().baseline!!

        platformUpdateUserProfile("u1", loaded, loaded.copy(title = "Head Auntie"))

        val w = writes.single()
        assertEquals("timestampValue", w.fields["updatedAt"]!!.jsonObject.keys.single(), "updatedAt was read as a Timestamp and must stay one: ${w.fields["updatedAt"]}")
        assertFalse("createdAt" in w.mask, "createdAt is never round-tripped")
        assertFalse("staffRole" in w.mask, "a field the model does not carry is never in the mask, so it survives")
    }

    @Test
    fun anUnchangedSaveWritesNothing() = runBlocking {
        seedOperator()
        val loaded = loadOperator().baseline!!
        assertEquals(WriteResult.Ok(Unit), platformUpdateUserProfile("u1", loaded, loaded))
        assertTrue(writes.isEmpty(), "nothing changed, so not even the stamp moves")
    }

    @Test
    fun clearingAFieldIsAChangeAndWritesBlank() = runBlocking {
        seedOperator()
        val loaded = loadOperator().baseline!!
        platformUpdateUserProfile("u1", loaded, loaded.copy(title = ""))
        assertEquals(str(""), writes.single().fields["title"])
    }

    @Test
    fun aThemeSaveWritesOnlyThemeMode() = runBlocking {
        seedOperator()
        val loaded = loadOperator().baseline!!
        platformUpdateUserProfile("u1", loaded, loaded.copy(themeMode = "LIGHT"))
        assertEquals(setOf("themeMode", "updatedAt"), writes.single().mask.toSet())
    }

    @Test
    fun aMissingDocumentIsCreatedWithOnlyWhatWasFilledIn() = runBlocking {
        val load = loadOperator()
        assertEquals(ProfileLoad.Loaded(null), load, "no document is a successful read")

        platformUpdateUserProfile("u1", null, UserProfile(uid = "u1", email = "op@example.com", phone = "555-0100"))

        val w = writes.single()
        assertEquals("PATCH /users/u1", "${w.method} ${w.path}", "a masked PATCH, never a whole-document replace")
        assertEquals(setOf("uid", "email", "phone", "updatedAt"), w.mask.toSet())
    }

    // ── the next save diffs against what this screen just wrote ─────────────

    @Test
    fun aSecondSaveBeforeThePollCatchesUpStillWritesTheRevert() = runBlocking {
        seedOperator()
        val stream = loadOperator()
        val read = stream.baseline!!

        val first = read.copy(themeMode = "LIGHT")
        platformUpdateUserProfile("u1", read, first)
        val pending = SavedProfile(readBefore = read, saved = first)

        // The poll has not caught up: the stream still holds `read` (DARK).
        val baseline = effectiveProfileLoad(stream, pending).baseline!!
        assertEquals("LIGHT", baseline.themeMode)
        platformUpdateUserProfile("u1", baseline, baseline.copy(themeMode = "DARK"))

        assertEquals(2, writes.size, "switching back must write; diffing against the stale read would write nothing")
        assertEquals(str("DARK"), writes[1].fields["themeMode"])
        // Once the stream moves on, it wins again.
        val caughtUp = ProfileLoad.Loaded(read.copy(themeMode = "DARK", updatedAt = "later"))
        assertEquals(caughtUp, effectiveProfileLoad(caughtUp, pending))
    }

    @Test
    fun theProfileFormIsDirtyOnlyWhenAShownFieldChanged() {
        val p = UserProfile(uid = "u1", displayName = "Syd", phone = "1")
        assertFalse(profileFormChanged(p, p.copy(email = "other@example.com")))
        assertTrue(profileFormChanged(p, p.copy(phone = "2")))
        assertFalse(profileFormChanged(null, UserProfile(uid = "u1")), "a blank form over no document has nothing to save")
    }
}
