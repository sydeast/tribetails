package com.tribetails.auntieos.web.data

import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.KSerializer
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.net.InetSocketAddress
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * #857: a desktop load-then-save must write a Firestore Timestamp back as a
 * Timestamp. The REST codec flattens `timestampValue` to an ISO string for the
 * models, and before this fix it wrote every string back as `stringValue`, so a
 * field read as a Timestamp came back from any desktop save as a string.
 *
 * A local HTTP server stands in for Firestore REST: it serves typed documents on
 * GET and records the body of every write, so each test asserts the exact value
 * envelope the desktop sent.
 */
class DesktopTimestampRoundTripTest {

    private lateinit var server: HttpServer
    private val docs = mutableMapOf<String, JsonObject>()
    private val writes = mutableListOf<Pair<String, JsonObject>>()

    @BeforeTest
    fun setUp() {
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { ex ->
            val path = ex.requestURI.rawPath.substringAfter("/documents")
            val body = ex.requestBody.readBytes().decodeToString()
            val (status, out) = when {
                ex.requestMethod == "GET" -> {
                    val rel = path.removePrefix("/")
                    val doc = docs[rel]
                    when {
                        doc != null -> 200 to doc.toString()
                        docs.keys.any { it.substringBeforeLast('/') == rel } -> 200 to buildJsonObject {
                            put("documents", buildJsonArray { docs.filterKeys { it.substringBeforeLast('/') == rel }.values.forEach { add(it) } })
                        }.toString()
                        else -> 404 to "{}"
                    }
                }
                ex.requestMethod == "POST" && path == ":runQuery" -> {
                    val from = Json.parseToJsonElement(body).jsonObject["structuredQuery"]!!.jsonObject["from"]!!.jsonArray[0].jsonObject
                    val group = from["collectionId"]!!.jsonPrimitive.content
                    200 to buildJsonArray {
                        docs.filterKeys { it.split('/').dropLast(1).last() == group }.values.forEach { add(buildJsonObject { put("document", it) }) }
                    }.toString()
                }
                else -> {
                    synchronized(writes) { writes += (ex.requestMethod + " " + path) to Json.parseToJsonElement(body).jsonObject }
                    200 to (if (ex.requestMethod == "POST" && !path.startsWith(":")) """{"name":"projects/p/databases/(default)/documents$path/new1"}""" else "{}")
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
        server.stop(0)
    }

    private fun seed(path: String, fields: JsonObject) {
        docs[path] = buildJsonObject {
            put("name", "projects/p/databases/(default)/documents/$path")
            put("fields", fields)
        }
    }

    private fun ts(iso: String) = buildJsonObject { put("timestampValue", iso) }
    private fun str(s: String) = buildJsonObject { put("stringValue", s) }

    /** The `fields` envelope of the only write the test made. */
    private fun onlyWriteFields(): JsonObject {
        assertEquals(1, writes.size, "expected one write, got ${writes.map { it.first }}")
        return writes.single().second["fields"]!!.jsonObject
    }

    // ── the proof ──────────────────────────────────────────────────────────

    /**
     * The defect as the issue describes it: a kin whose `updatedAt` is a
     * Timestamp (23 of 24 live kin), loaded and saved through the real desktop
     * kin save. #895 moved kin saves to a merge of the changed fields only, so
     * an unchanged `updatedAt` is no longer sent at all; this pins that a kin
     * write that does carry `updatedAt` still sends it as a Timestamp.
     */
    @Test
    fun aKinLoadedAndSavedKeepsItsUpdatedAtTimestamp() = runBlocking {
        seed("kin/k1", buildJsonObject {
            put("kinfolkId", str("kf1"))
            put("name", str("Biscuit"))
            put("updatedAt", ts("2025-03-04T05:06:07.123456Z"))
        })
        val kin = JvmFirestoreRest.getDoc<Kin>("kin", "k1")!!
        assertEquals("2025-03-04T05:06:07.123456Z", kin.updatedAt, "the model reads the timestamp as its ISO string")

        assertEquals(WriteResult.Ok(Unit), platformUpdateKinFields("k1", kinChanges(kin, kin.copy(updatedAt = "2025-03-04T05:06:08Z"))))

        val updatedAt = onlyWriteFields()["updatedAt"]!!.jsonObject
        assertEquals(ts("2025-03-04T05:06:08Z"), updatedAt, "updatedAt went back as $updatedAt")
    }

    /**
     * The discriminator: the web admin and functions store several time fields
     * as ISO strings on purpose (inbox `repliedAt`, template `updatedAt`,
     * booking `startTime`). A field that ARRIVED as a string stays a string, even
     * when it looks like an instant.
     */
    @Test
    fun anIsoStringThatArrivedAsAStringStaysAString() = runBlocking {
        seed("kin/k2", buildJsonObject {
            put("kinfolkId", str("kf1"))
            put("updatedAt", str("2025-03-04T05:06:07.123Z"))
        })
        val kin = JvmFirestoreRest.getDoc<Kin>("kin", "k2")!!
        platformUpdateKinFields("k2", kinChanges(kin, kin.copy(updatedAt = "2025-03-04T05:06:08.000Z")))
        assertEquals(str("2025-03-04T05:06:08.000Z"), onlyWriteFields()["updatedAt"])
    }

    // ── what the codec decides ──────────────────────────────────────────────
    @Test
    fun aTimestampFieldEditedToSomethingThatIsNotADateTimeWritesAString() = runBlocking {
        seed("kinfolk/kf1", buildJsonObject {
            put("joinDate", ts("2024-07-24T12:34:56.789Z"))
            put("updatedAt", ts("2024-07-24T12:34:56.789Z"))
        })
        JvmFirestoreRest.getDocPlain("kinfolk", "kf1")
        // The web editor writes joinDate as YYYY-MM-DD; a bare day is not an instant.
        JvmFirestoreRest.patchFields("kinfolk", "kf1", mapOf("joinDate" to JsonPrimitive("2024-07-24"), "updatedAt" to JsonPrimitive("")))
        val fields = onlyWriteFields()
        assertEquals(str("2024-07-24"), fields["joinDate"])
        assertEquals(str(""), fields["updatedAt"])
    }
    /**
     * #1155: a zone-less stamp at a Timestamp path is the BUSINESS's wall clock. The
     * machine is in Los Angeles and the business in Chicago: 10:11:12 on the
     * business clock (CDT) is 15:11:12Z, where the machine's zone would say 17:11:12Z.
     */
    @Test
    fun aZonelessStampAtATimestampPathIsSentAsThatBusinessInstant() = runBlocking {
        val originalZone = java.util.TimeZone.getDefault()
        java.util.TimeZone.setDefault(java.util.TimeZone.getTimeZone("America/Los_Angeles"))
        val originalSettings = JvmFirestoreFixtures.businessSettings
        JvmFirestoreFixtures.businessSettings = BusinessSettings(timeZone = "America/Chicago")
        try {
            seed("kinfolk/kf2", buildJsonObject { put("updatedAt", ts("2024-01-01T00:00:00Z")) })
            JvmFirestoreRest.getDocPlain("kinfolk", "kf2")
            JvmFirestoreRest.patchFields("kinfolk", "kf2", mapOf("updatedAt" to JsonPrimitive("2026-09-27T10:11:12")))
            assertEquals(ts("2026-09-27T15:11:12Z"), onlyWriteFields()["updatedAt"])
            assertEquals("2026-09-27T15:11:12Z", JvmFirestoreRest.timestampValueOf("2026-09-27T10:11:12"))
        } finally {
            JvmFirestoreFixtures.businessSettings = originalSettings
            java.util.TimeZone.setDefault(originalZone)
        }
    }
    /** #1155: `nowIso()` is on the same business clock, so a stamp round-trips to the real "now". */
    @Test
    fun nowIsoRoundTripsToTheCurrentInstantOnAMachineInAnotherZone() {
        val originalZone = java.util.TimeZone.getDefault()
        java.util.TimeZone.setDefault(java.util.TimeZone.getTimeZone("America/Los_Angeles"))
        val originalSettings = JvmFirestoreFixtures.businessSettings
        JvmFirestoreFixtures.businessSettings = BusinessSettings(timeZone = "America/Chicago")
        try {
            val before = System.currentTimeMillis() - 2_000
            val sent = JvmFirestoreRest.timestampValueOf(com.tribetails.auntieos.web.util.nowIso())
            val after = System.currentTimeMillis() + 2_000
            val ms = java.time.Instant.parse(sent!!).toEpochMilli()
            assertTrue(ms in before..after, "nowIso sent as $sent, which is not now")
        } finally {
            JvmFirestoreFixtures.businessSettings = originalSettings
            java.util.TimeZone.setDefault(originalZone)
        }
    }
    @Test
    fun timestampValueOfAcceptsDateTimesOnly() {
        assertEquals("2026-01-02T03:04:05.123456789Z", JvmFirestoreRest.timestampValueOf("2026-01-02T03:04:05.123456789Z"))
        assertEquals("2026-01-02T03:04:05-05:00", JvmFirestoreRest.timestampValueOf("2026-01-02T03:04:05-05:00"))
        for (notOne in listOf("", "2026-01-02", "07/24/2026", "soon", "2026-13-40T99:00:00Z")) {
            assertEquals(null, JvmFirestoreRest.timestampValueOf(notOne), "'$notOne' read as a date-time")
        }
    }
    @Test
    fun nestedMapAndArrayTimestampsRoundTrip() = runBlocking {
        seed("household_data/kf1", buildJsonObject {
            put("kinfolkId", str("kf1"))
            put("meta", buildJsonObject {
                put("mapValue", buildJsonObject {
                    put("fields", buildJsonObject {
                        put("checkedAt", ts("2025-05-05T05:05:05Z"))
                        put("note", str("2025-05-05T05:05:05Z"))
                    })
                })
            })
            put("history", buildJsonObject {
                put("arrayValue", buildJsonObject {
                    put("values", buildJsonArray {
                        add(buildJsonObject { put("mapValue", buildJsonObject { put("fields", buildJsonObject { put("at", ts("2025-06-06T06:06:06Z")) }) }) })
                        add(buildJsonObject { put("mapValue", buildJsonObject { put("fields", buildJsonObject { put("at", ts("2025-07-07T07:07:07Z")) }) }) })
                    })
                })
            })
        })
        val plain = JvmFirestoreRest.getDocPlain("household_data", "kf1")!!
        JvmFirestoreRest.setDoc("household_data", "kf1", plain.toString())
        val fields = onlyWriteFields()
        val meta = fields["meta"]!!.jsonObject["mapValue"]!!.jsonObject["fields"]!!.jsonObject
        assertEquals(ts("2025-05-05T05:05:05Z"), meta["checkedAt"])
        assertEquals(str("2025-05-05T05:05:05Z"), meta["note"], "a string sibling stays a string")
        val history = fields["history"]!!.jsonObject["arrayValue"]!!.jsonObject["values"]!!.jsonArray
        assertEquals(
            listOf(ts("2025-06-06T06:06:06Z"), ts("2025-07-07T07:07:07Z")),
            history.map { it.jsonObject["mapValue"]!!.jsonObject["fields"]!!.jsonObject["at"] },
        )
    }
    // ── every write path ────────────────────────────────────────────────────
    /** A collection poll (the path every list screen takes) records the types too. */
    @Test
    fun aDocReadThroughACollectionListKeepsItsTimestamps() = runBlocking {
        seed("kin/k3", buildJsonObject { put("kinfolkId", str("kf1")); put("updatedAt", ts("2025-01-01T00:00:00Z")) })
        val kin = JvmFirestoreRest.list<Kin>("kin").single()
        platformUpdateKinFields("k3", kinChanges(kin, kin.copy(updatedAt = "2025-01-01T00:00:01Z")))
        assertEquals(ts("2025-01-01T00:00:01Z"), onlyWriteFields()["updatedAt"])
    }
    /** A collectionGroup query (the incoming kinCares queue) records under the doc's full path. */
    @Test
    fun aDocReadThroughACollectionGroupQueryKeepsItsTimestamps() = runBlocking {
        seed("families/f1/bookings/b1/kinCares/v1", buildJsonObject { put("status", str("x")); put("arrivedAt", ts("2025-02-02T02:02:02Z")) })
        JvmFirestoreRest.runCollectionGroupQueryWhereEq("kinCares", "status", "x")
        assertEquals(setOf(listOf("arrivedAt")), JvmFirestoreRest.timestampPathsOf("families/f1/bookings/b1/kinCares/v1"))
    }
    /** mergeDoc: the business settings first save (no baseline) takes this path. */
    @Test
    fun mergeDocKeepsTimestamps() = runBlocking {
        seed("business_settings/business_settings", buildJsonObject { put("updatedAt", ts("2025-03-03T03:03:03Z")) })
        val plain = JvmFirestoreRest.getDocPlain("business_settings", "business_settings")!!
        JvmFirestoreRest.mergeDoc("business_settings", "business_settings", plain.toString())
        assertEquals(ts("2025-03-03T03:03:03Z"), onlyWriteFields()["updatedAt"])
    }
    /** The only desktop kinfolk update path, including a custom field under formValues. */
    @Test
    fun theKinfolkMergeKeepsTimestampsAtTopLevelAndUnderFormValues() = runBlocking {
        seed("kinfolk/kf3", buildJsonObject {
            put("updatedAt", ts("2025-04-04T04:04:04Z"))
            put("formValues", buildJsonObject {
                put("mapValue", buildJsonObject { put("fields", buildJsonObject { put("vaccine.due", ts("2025-12-01T00:00:00Z")) }) })
            })
        })
        JvmFirestoreRest.getDocPlain("kinfolk", "kf3")
        val result = platformUpdateKinfolkFields("kf3", listOf(
            KinfolkFieldChange(listOf("updatedAt"), JsonPrimitive("2025-04-05T00:00:00Z")),
            KinfolkFieldChange(listOf("formValues", "vaccine.due"), JsonPrimitive("2026-12-01T00:00:00Z")),
        ))
        assertEquals(WriteResult.Ok(Unit), result)
        val fields = onlyWriteFields()
        assertEquals(ts("2025-04-05T00:00:00Z"), fields["updatedAt"])
        val formValues = fields["formValues"]!!.jsonObject["mapValue"]!!.jsonObject["fields"]!!.jsonObject
        assertEquals(ts("2026-12-01T00:00:00Z"), formValues["vaccine.due"])
    }
    @Test
    fun patchFieldsKeepsTimestampsThroughAVoicemailReply() = runBlocking {
        seed("voicemails/vm1", buildJsonObject { put("repliedAt", ts("2025-01-01T00:00:00Z")) })
        JvmFirestoreRest.getDocPlain("voicemails", "vm1")
        assertEquals(WriteResult.Ok(Unit), platformMarkVoicemailReplied("vm1", "2025-09-09T09:09:09Z", "log1"))
        val fields = onlyWriteFields()
        assertEquals(ts("2025-09-09T09:09:09Z"), fields["repliedAt"])
        assertEquals(str("log1"), fields["replyLogId"])
    }
    @Test
    fun markReportSentKeepsTimestampsOnTheReportAndTheSession() = runBlocking {
        seed("kin_care_reports/r1", buildJsonObject { put("sentAt", ts("2025-01-01T00:00:00Z")); put("updatedAt", ts("2025-01-01T00:00:00Z")) })
        seed("kin_care_sessions/s1", buildJsonObject { put("updatedAt", ts("2025-01-01T00:00:00Z")) })
        JvmFirestoreRest.rawCollectionSuspend("kin_care_reports")
        JvmFirestoreRest.rawCollectionSuspend("kin_care_sessions")
        assertEquals(WriteResult.Ok(Unit), platformMarkKinTaleReportSent("r1", "s1", "email", "d1", "2025-09-09T09:09:09Z"))
        assertEquals(1, writes.size)
        val (report, session) = writes.single().second["writes"]!!.jsonArray.map { it.jsonObject["update"]!!.jsonObject["fields"]!!.jsonObject }
        assertEquals(ts("2025-09-09T09:09:09Z"), report["sentAt"])
        assertEquals("timestampValue", report["updatedAt"]!!.jsonObject.keys.single())
        assertEquals("timestampValue", session["updatedAt"]!!.jsonObject.keys.single())
        assertEquals(str("SENT"), report["status"])
    }
    /** A create has no read behind it, so it writes strings exactly as before #857. */
    @Test
    fun aCreateWritesStringsAsBefore() = runBlocking {
        platformCreateKin(Kin(kinfolkId = "kf1", updatedAt = "2025-01-01T00:00:00Z"))
        assertEquals(str("2025-01-01T00:00:00Z"), onlyWriteFields()["updatedAt"])
    }
    /**
     * The issue's "each collection the desktop writes": every whole-document
     * desktop save, through its real platform function and its real model. Each
     * String field of the model whose name reads as a time is seeded as a
     * Timestamp, loaded, saved unchanged, and must come back as a Timestamp.
     */
    @Test
    fun everyWholeDocumentDesktopSaveKeepsTheTimestampsItsModelCarries() = runBlocking {
        suspend fun <T> check(collection: String, id: String, serializer: KSerializer<T>, save: suspend (T) -> Any?, extra: JsonObject = JsonObject(emptyMap())): List<String> {
            writes.clear()
            val d = serializer.descriptor
            val timeFields = (0 until d.elementsCount)
                .filter { d.getElementDescriptor(it).kind == PrimitiveKind.STRING }
                .map { d.getElementName(it) }
                .filter { it != "_id" && Regex("(At|Date|date|Time|On)$").containsMatchIn(it) }
            seed("$collection/$id", buildJsonObject {
                extra.forEach { (k, v) -> put(k, v) }
                timeFields.forEachIndexed { i, f -> put(f, ts("2025-01-0${i % 9 + 1}T00:00:00Z")) }
            })
            val model = Json { ignoreUnknownKeys = true; isLenient = true }.decodeFromJsonElement(serializer, JvmFirestoreRest.getDocPlain(collection, id)!!)
            save(model)
            val fields = onlyWriteFields()
            timeFields.forEachIndexed { i, f ->
                assertEquals(ts("2025-01-0${i % 9 + 1}T00:00:00Z"), fields[f], "$collection.$f went back as ${fields[f]}")
            }
            return timeFields
        }
        val covered = mapOf(
            "payments" to check("payments", "p9", Payment.serializer(), { platformRecordPayment(it, "p9") }),
            // users: no longer a whole-document save (#897); a masked diff write,
            // covered with its Timestamps by DesktopUserProfileSaveTest.
        )
        println("[#857] timestamp fields checked per collection: $covered")
        // #895: kin left this sweep; its saves are merges of changed fields only
        // (DesktopKinMergeTest), so an unchanged kin writes nothing.
        // #994: kin_care_reports, kintale_templates, vet_clinics, household_data and
        // dynamic_fields left it too, for the same reason; their Timestamps are
        // covered by DesktopDiffedSavesTest.
        assertTrue(covered.getValue("payments").isNotEmpty())
    }
}
