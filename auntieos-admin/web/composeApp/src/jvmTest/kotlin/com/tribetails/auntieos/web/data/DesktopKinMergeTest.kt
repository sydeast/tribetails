package com.tribetails.auntieos.web.data

import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
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
import kotlin.test.assertNull

/**
 * #895: desktop kin (pet) saves wrote the whole document (`setDoc`, a PATCH with
 * no updateMask). Every save deleted the fields the desktop `Kin` model does not
 * carry and put back the stale value of every field another client had changed
 * since the 8-second poll. Saves now send only the fields the operator changed,
 * with an updateMask.
 *
 * A local HTTP server stands in for Firestore REST and applies a PATCH the way
 * Firestore does: with `updateMask.fieldPaths`, only the named paths are set
 * (or deleted when the body leaves them out); without one, the body replaces the
 * whole document. Tests assert on the stored document afterwards, so they check
 * what survives, not only what was sent.
 */
class DesktopKinMergeTest {

    private lateinit var server: HttpServer
    private val docs = mutableMapOf<String, JsonObject>()
    private val masks = mutableListOf<List<String>?>()

    @BeforeTest
    fun setUp() {
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { ex ->
            val rel = ex.requestURI.rawPath.substringAfter("/documents/")
            val body = ex.requestBody.readBytes().decodeToString()
            val (status, out) = when (ex.requestMethod) {
                "GET" -> docs[rel]?.let { 200 to docJson(rel, it).toString() } ?: (404 to "{}")
                "PATCH" -> {
                    val mask = ex.requestURI.rawQuery.orEmpty().split('&')
                        .filter { it.startsWith("updateMask.fieldPaths=") }
                        .map { URLDecoder.decode(it.substringAfter('='), "UTF-8") }
                        .takeIf { it.isNotEmpty() }
                    val sent = Json.parseToJsonElement(body).jsonObject["fields"]?.jsonObject ?: JsonObject(emptyMap())
                    synchronized(masks) { masks += mask }
                    docs[rel] = if (mask == null) sent else applyMask(docs[rel] ?: JsonObject(emptyMap()), sent, mask)
                    200 to docJson(rel, docs.getValue(rel)).toString()
                }
                else -> 405 to "{}"
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
        server.stop(0)
    }

    // ── a Firestore-shaped store ────────────────────────────────────────────

    private fun docJson(path: String, fields: JsonObject) = buildJsonObject {
        put("name", "projects/p/databases/(default)/documents/$path")
        put("fields", fields)
    }

    /** Splits a Firestore field path on dots outside backticks and unquotes each segment. */
    private fun segments(path: String): List<String> {
        val out = mutableListOf<String>()
        val cur = StringBuilder()
        var quoted = false
        var i = 0
        while (i < path.length) {
            val ch = path[i]
            when {
                quoted && ch == '\\' -> { cur.append(path[i + 1]); i++ }
                ch == '`' -> quoted = !quoted
                !quoted && ch == '.' -> { out += cur.toString(); cur.clear() }
                else -> cur.append(ch)
            }
            i++
        }
        out += cur.toString()
        return out
    }

    private fun mapFields(v: JsonObject?): JsonObject? = v?.get("mapValue")?.jsonObject?.get("fields")?.jsonObject

    /** Sets (or, when [value] is null, deletes) [path] in a `fields` object. */
    private fun setAt(fields: JsonObject, path: List<String>, value: JsonObject?): JsonObject {
        val head = path.first()
        val m = fields.toMutableMap()
        if (path.size == 1) {
            if (value == null) m.remove(head) else m[head] = value
        } else {
            val child = mapFields(fields[head]?.jsonObject) ?: JsonObject(emptyMap())
            m[head] = buildJsonObject { put("mapValue", buildJsonObject { put("fields", setAt(child, path.drop(1), value)) }) }
        }
        return JsonObject(m)
    }

    private fun getAt(fields: JsonObject?, path: List<String>): JsonObject? {
        val v = fields?.get(path.first())?.jsonObject ?: return null
        return if (path.size == 1) v else getAt(mapFields(v), path.drop(1))
    }

    private fun applyMask(stored: JsonObject, sent: JsonObject, mask: List<String>): JsonObject =
        mask.fold(stored) { acc, p -> segments(p).let { seg -> setAt(acc, seg, getAt(sent, seg)) } }

    private fun seed(path: String, fields: JsonObject) { docs[path] = fields }
    private fun ts(iso: String) = buildJsonObject { put("timestampValue", iso) }
    private fun str(s: String) = buildJsonObject { put("stringValue", s) }
    private fun map(vararg kv: Pair<String, JsonObject>) =
        buildJsonObject { put("mapValue", buildJsonObject { put("fields", JsonObject(kv.toMap())) }) }

    /** A kin as the live data holds it: a Timestamp `updatedAt` and one field the desktop model does not carry. */
    private fun seedKin() = seed("kin/k1", buildJsonObject {
        put("kinfolkId", str("kf1"))
        put("name", str("Biscuit"))
        put("species", str("Dog"))
        put("vaccinations", str("Rabies 2025"))
        put("medicationHealthNotes", str("none"))
        put("tags", buildJsonObject { put("arrayValue", buildJsonObject { put("values", kotlinx.serialization.json.buildJsonArray { add(str("Calm")) }) }) })
        put("updatedAt", ts("2025-03-04T05:06:07.123456Z"))
        put("portalOnly", str("written by the household portal"))
        put("formValues", map("feeding.am" to str("1 cup"), "walk time" to str("7am")))
    })

    private val stored get() = docs.getValue("kin/k1")

    // ── the defect, end to end ─────────────────────────────────────────────

    /**
     * The operator opens the pet, the household edits `vaccinations` in the
     * portal during the poll gap, then the operator saves a new name. The name
     * lands; the household's vaccinations, the field the desktop model lacks
     * and the Timestamp `updatedAt` all survive.
     */
    @Test
    fun aKinEditWritesOnlyItsFieldAndKeepsEverythingElse() = runBlocking<Unit> {
        seedKin()
        val loaded = JvmFirestoreRest.getDoc<Kin>("kin", "k1")!!
        // The concurrent edit from another client, after the desktop's read.
        docs["kin/k1"] = setAt(stored, listOf("vaccinations"), str("Rabies 2026, DHPP"))

        val r = FirestoreClient().updateKin(loaded, loaded.copy(name = "Biscuit Jr."))

        assertEquals(WriteResult.Ok(true), r)
        assertEquals(listOf<List<String>?>(listOf("name")), masks, "only the changed field is in the mask")
        assertEquals(str("Biscuit Jr."), stored["name"], "the changed field is written")
        assertEquals(str("Rabies 2026, DHPP"), stored["vaccinations"], "a concurrent change to another field survives")
        assertEquals(str("written by the household portal"), stored["portalOnly"], "a field the model lacks survives")
        assertEquals(ts("2025-03-04T05:06:07.123456Z"), stored["updatedAt"], "the Timestamp stays a Timestamp")
        assertEquals(str("1 cup"), getAt(stored, listOf("formValues", "feeding.am")))
    }

    /** A written field that the doc read as a Timestamp is sent back typed (the #857 record, carried by bodyFrom). */
    @Test
    fun aChangedTimestampFieldIsWrittenAsATimestamp() = runBlocking<Unit> {
        seedKin()
        val loaded = JvmFirestoreRest.getDoc<Kin>("kin", "k1")!!
        FirestoreClient().updateKin(loaded, loaded.copy(updatedAt = "2026-09-27T10:11:12Z", weight = "40"))
        assertEquals(setOf("updatedAt", "weight"), masks.single()!!.toSet())
        assertEquals(ts("2026-09-27T10:11:12Z"), stored["updatedAt"])
        assertEquals(str("40"), stored["weight"])
        assertEquals(str("written by the household portal"), stored["portalOnly"])
    }

    @Test
    fun aTagChangeWritesOnlyTags() = runBlocking<Unit> {
        seedKin()
        val loaded = JvmFirestoreRest.getDoc<Kin>("kin", "k1")!!
        docs["kin/k1"] = setAt(stored, listOf("medicationHealthNotes"), str("insulin 2x daily"))

        assertEquals(WriteResult.Ok(Unit), FirestoreClient().updateKinTags(loaded, listOf("Calm", "Senior")))

        assertEquals(listOf<List<String>?>(listOf("tags")), masks)
        assertEquals(str("insulin 2x daily"), stored["medicationHealthNotes"], "the concurrent health note survives a tag save")
        assertEquals(str("written by the household portal"), stored["portalOnly"])
        assertEquals(ts("2025-03-04T05:06:07.123456Z"), stored["updatedAt"])
    }

    @Test
    fun aPhotoChangeWritesOnlyProfilePictureUrl() = runBlocking<Unit> {
        seedKin()
        val loaded = JvmFirestoreRest.getDoc<Kin>("kin", "k1")!!
        docs["kin/k1"] = setAt(stored, listOf("name"), str("Renamed on Android"))

        val r = com.tribetails.auntieos.web.screens.directory.writeKinPhoto(FirestoreClient(), loaded, "https://new.jpg")

        assertEquals(WriteResult.Ok(loaded.copy(profilePictureUrl = "https://new.jpg")), r)
        assertEquals(listOf<List<String>?>(listOf("profilePictureUrl")), masks)
        assertEquals(str("https://new.jpg"), stored["profilePictureUrl"])
        assertEquals(str("Renamed on Android"), stored["name"], "the concurrent rename survives a photo change")
        assertEquals(str("written by the household portal"), stored["portalOnly"])
    }

    /** Custom KIN form fields are diffed per key, and keys with dots or spaces are quoted in the mask. */
    @Test
    fun formValuesAreWrittenAndDeletedPerKey() = runBlocking<Unit> {
        seedKin()
        val loaded = JvmFirestoreRest.getDoc<Kin>("kin", "k1")!!
        // Another admin adds a key the desktop never saw.
        docs["kin/k1"] = setAt(stored, listOf("formValues", "crate"), str("yes"))

        val edited = loaded.copy(formValues = mapOf("feeding.am" to "2 cups"))
        FirestoreClient().updateKin(loaded, edited)

        assertEquals(setOf("formValues.`feeding.am`", "formValues.`walk time`"), masks.single()!!.toSet())
        assertEquals(str("2 cups"), getAt(stored, listOf("formValues", "feeding.am")), "the edited key is written")
        assertNull(getAt(stored, listOf("formValues", "walk time")), "the removed key is deleted")
        assertEquals(str("yes"), getAt(stored, listOf("formValues", "crate")), "another client's key survives")
    }

    @Test
    fun anUnchangedSaveWritesNothing() = runBlocking<Unit> {
        seedKin()
        val loaded = JvmFirestoreRest.getDoc<Kin>("kin", "k1")!!
        assertEquals(WriteResult.Ok(false), FirestoreClient().updateKin(loaded, loaded.copy()))
        assertEquals(emptyList<List<String>?>(), masks)
    }

    @Test
    fun kinChangesNeverNamesId() {
        val changes = kinChanges(Kin(_id = "a", name = "x"), Kin(_id = "b", name = "y"))
        assertEquals(listOf<List<String>?>(listOf("name")), changes.map { it.path })
        assertFalse(changes.any { it.path.first() == "_id" })
    }
}
