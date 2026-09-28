package com.tribetails.auntieos.web.data

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #994: five more desktop saves wrote the whole document (`setDoc`, a PATCH with
 * no updateMask): `kin_care_reports`, `kintale_templates`, `vet_clinics`,
 * `household_data` and `dynamic_fields`. Every save deleted the fields the
 * desktop model does not carry and put back the stale value of every field
 * another client changed since load. Saves now send only the fields that
 * changed relative to the record the screen loaded, with an updateMask, the
 * #895 mechanism (DesktopKinMergeTest).
 *
 * [MaskApplyingFirestore] applies each PATCH the way Firestore does, so the
 * assertions are on the stored document: what survives, not only what was sent.
 *
 * `vet_clinics` is refused to every client by `firestore.rules`, so its save
 * goes through the `updateVetClinic` callable instead; those tests answer the
 * callable from JvmFirestoreFixtures and pin the request. #998 extends this to
 * create (`submitVetClinic`, replacing a direct `addDoc`) and archive/restore
 * (`archiveVetClinic`, replacing a direct `deleteDoc`).
 */
class DesktopDiffedSavesTest {

    private val fs = MaskApplyingFirestore()
    private val docs get() = fs.docs
    private val masks get() = fs.masks

    @BeforeTest
    fun setUp() = fs.start()

    @AfterTest
    fun tearDown() = fs.stop()

    private fun ts(iso: String) = MaskApplyingFirestore.ts(iso)
    private fun str(s: String) = MaskApplyingFirestore.str(s)
    private fun map(vararg kv: Pair<String, JsonObject>) = MaskApplyingFirestore.map(*kv)
    private fun stored(path: String) = docs.getValue(path)
    private fun concurrent(path: String, field: List<String>, value: JsonObject) {
        docs[path] = fs.setAt(stored(path), field, value)
    }

    // ── kin_care_reports ────────────────────────────────────────────────────

    private fun seedReport() {
        docs["kin_care_reports/r1"] = buildJsonObject {
            put("sessionId", str("s1"))
            put("kinfolkId", str("kf1"))
            put("title", str("Walk with Biscuit"))
            put("bodyCopy", str("A good walk."))
            put("status", str("DRAFT"))
            put("updatedAt", ts("2025-03-04T05:06:07.123456Z"))
            put("sentAt", ts("2025-03-04T06:00:00Z"))
            put("triageNote", str("a field the desktop model lacks"))
            put("fieldResponses", map(
                "k1|fed" to map("fieldKey" to str("fed"), "kinId" to str("k1"), "boolValue" to buildJsonObject { put("booleanValue", false) }),
                "k1|walked" to map("fieldKey" to str("walked"), "kinId" to str("k1"), "boolValue" to buildJsonObject { put("booleanValue", true) }),
            ))
        }
    }

    @Test
    fun aReportEditWritesOnlyItsFieldAndKeepsEverythingElse() = runBlocking<Unit> {
        seedReport()
        val loaded = JvmFirestoreRest.getDoc<KinCareReport>("kin_care_reports", "r1")!!
        concurrent("kin_care_reports/r1", listOf("title"), str("Retitled on Android"))

        val r = FirestoreClient().updateKinTaleReport(loaded, loaded.copy(bodyCopy = "A long, good walk."))

        assertEquals(WriteResult.Ok(true), r)
        assertEquals(listOf<List<String>?>(listOf("bodyCopy")), masks)
        val doc = stored("kin_care_reports/r1")
        assertEquals(str("A long, good walk."), doc["bodyCopy"])
        assertEquals(str("Retitled on Android"), doc["title"], "a concurrent change to another field survives")
        assertEquals(str("a field the desktop model lacks"), doc["triageNote"], "a field the model lacks survives")
        assertEquals(ts("2025-03-04T05:06:07.123456Z"), doc["updatedAt"], "an unwritten Timestamp stays a Timestamp")
        assertEquals(ts("2025-03-04T06:00:00Z"), doc["sentAt"])
    }

    @Test
    fun aReportChecklistTickWritesOnlyThatResponse() = runBlocking<Unit> {
        seedReport()
        val loaded = JvmFirestoreRest.getDoc<KinCareReport>("kin_care_reports", "r1")!!
        // Another client ticks a different item after the desktop's read.
        concurrent("kin_care_reports/r1", listOf("fieldResponses", "k1|meds"), map("fieldKey" to str("meds"), "kinId" to str("k1")))

        val fed = loaded.fieldResponses.getValue("k1|fed").copy(boolValue = true)
        FirestoreClient().updateKinTaleReport(loaded, loaded.copy(fieldResponses = loaded.fieldResponses + ("k1|fed" to fed)))

        assertEquals(listOf<List<String>?>(listOf("fieldResponses.`k1|fed`")), masks)
        val doc = stored("kin_care_reports/r1")
        assertEquals(buildJsonObject { put("booleanValue", true) }, fs.getAt(doc, listOf("fieldResponses", "k1|fed", "boolValue")))
        assertTrue(fs.getAt(doc, listOf("fieldResponses", "k1|meds")) != null, "another client's response survives")
        assertTrue(fs.getAt(doc, listOf("fieldResponses", "k1|walked")) != null)
    }

    @Test
    fun aChangedReportTimestampIsWrittenAsATimestamp() = runBlocking<Unit> {
        seedReport()
        val loaded = JvmFirestoreRest.getDoc<KinCareReport>("kin_care_reports", "r1")!!
        FirestoreClient().updateKinTaleReport(loaded, loaded.copy(updatedAt = "2026-09-27T10:11:12Z", title = "New"))
        assertEquals(setOf("updatedAt", "title"), masks.single()!!.toSet())
        assertEquals(ts("2026-09-27T10:11:12Z"), stored("kin_care_reports/r1")["updatedAt"])
    }

    @Test
    fun anUnchangedReportSaveWritesNothing() = runBlocking<Unit> {
        seedReport()
        val loaded = JvmFirestoreRest.getDoc<KinCareReport>("kin_care_reports", "r1")!!
        assertEquals(WriteResult.Ok(false), FirestoreClient().updateKinTaleReport(loaded, loaded.copy()))
        assertEquals(WriteResult.Ok("r1"), FirestoreClient().saveReport(loaded, loaded.copy()))
        assertEquals(emptyList<List<String>?>(), masks)
    }

    // ── kintale_templates ───────────────────────────────────────────────────

    private fun seedTemplate() {
        docs["kintale_templates/t1"] = buildJsonObject {
            put("name", str("Drop-in"))
            put("description", str("Short visit"))
            put("isActive", buildJsonObject { put("booleanValue", true) })
            put("createdAt", ts("2025-01-01T00:00:00Z"))
            put("updatedAt", ts("2025-02-02T00:00:00Z"))
            put("ownerNote", str("a field the desktop model lacks"))
        }
    }

    @Test
    fun aTemplateEditWritesOnlyItsFieldAndKeepsEverythingElse() = runBlocking<Unit> {
        seedTemplate()
        val loaded = JvmFirestoreRest.getDoc<KinTaleTemplate>("kintale_templates", "t1")!!
        concurrent("kintale_templates/t1", listOf("description"), str("Edited on web"))

        val r = FirestoreClient().updateKinTaleTemplate(loaded, loaded.copy(name = "Drop-in visit"))

        assertEquals(WriteResult.Ok(true), r)
        assertEquals(listOf<List<String>?>(listOf("name")), masks)
        val doc = stored("kintale_templates/t1")
        assertEquals(str("Drop-in visit"), doc["name"])
        assertEquals(str("Edited on web"), doc["description"], "a concurrent change to another field survives")
        assertEquals(str("a field the desktop model lacks"), doc["ownerNote"])
        assertEquals(ts("2025-01-01T00:00:00Z"), doc["createdAt"])
        assertEquals(ts("2025-02-02T00:00:00Z"), doc["updatedAt"])
    }

    @Test
    fun anUnchangedTemplateSaveWritesNothing() = runBlocking<Unit> {
        seedTemplate()
        val loaded = JvmFirestoreRest.getDoc<KinTaleTemplate>("kintale_templates", "t1")!!
        assertEquals(WriteResult.Ok(false), FirestoreClient().updateKinTaleTemplate(loaded, loaded.copy()))
        assertEquals(emptyList<List<String>?>(), masks)
    }

    // ── household_data ──────────────────────────────────────────────────────

    private fun seedHousehold() {
        docs["household_data/kf1"] = buildJsonObject {
            put("kinfolkId", str("kf1"))
            put("foodLocation", str("Pantry"))
            put("groomerName", str("Suds"))
            put("createdAt", ts("2025-01-01T00:00:00Z"))
            put("updatedAt", ts("2025-02-02T00:00:00Z"))
            put("primaryVetClinicId", str("a field the desktop model lacks"))
        }
    }

    @Test
    fun aHouseholdEditWritesOnlyItsFieldAndKeepsEverythingElse() = runBlocking<Unit> {
        seedHousehold()
        val loaded = JvmFirestoreRest.getDoc<HouseholdData>("household_data", "kf1")!!
        concurrent("household_data/kf1", listOf("groomerName"), str("Suds and Co."))

        val r = FirestoreClient().saveHouseholdData(loaded, loaded.copy(foodLocation = "Garage shelf"))

        assertEquals(WriteResult.Ok(true), r)
        assertEquals(listOf<List<String>?>(listOf("foodLocation")), masks, "kinfolkId and createdAt are never re-sent")
        val doc = stored("household_data/kf1")
        assertEquals(str("Garage shelf"), doc["foodLocation"])
        assertEquals(str("Suds and Co."), doc["groomerName"], "a concurrent change to another field survives")
        assertEquals(str("a field the desktop model lacks"), doc["primaryVetClinicId"])
        assertEquals(ts("2025-01-01T00:00:00Z"), doc["createdAt"])
        assertEquals(ts("2025-02-02T00:00:00Z"), doc["updatedAt"])
    }

    @Test
    fun aNewHouseholdWritesOnlyFilledFieldsAndKinfolkId() = runBlocking<Unit> {
        val r = FirestoreClient().saveHouseholdData(null, HouseholdData(kinfolkId = "kf2", foodLocation = "Pantry"))
        assertEquals(WriteResult.Ok(true), r)
        assertEquals(setOf("foodLocation", "kinfolkId"), masks.single()!!.toSet())
        assertEquals(
            buildJsonObject { put("foodLocation", str("Pantry")); put("kinfolkId", str("kf2")) },
            stored("household_data/kf2"),
        )
    }

    @Test
    fun aBlankNewHouseholdWritesNothing() = runBlocking<Unit> {
        assertEquals(WriteResult.Ok(false), FirestoreClient().saveHouseholdData(null, HouseholdData(kinfolkId = "kf2")))
        assertEquals(emptyList<List<String>?>(), masks)
        assertFalse("household_data/kf2" in docs)
    }

    @Test
    fun anUnchangedHouseholdSaveWritesNothing() = runBlocking<Unit> {
        seedHousehold()
        val loaded = JvmFirestoreRest.getDoc<HouseholdData>("household_data", "kf1")!!
        assertEquals(WriteResult.Ok(false), FirestoreClient().saveHouseholdData(loaded, loaded.copy()))
        assertEquals(emptyList<List<String>?>(), masks)
    }

    // ── dynamic_fields (no caller today; the mechanism is still the masked merge) ──

    @Test
    fun aDynamicFieldEditWritesOnlyItsField() = runBlocking<Unit> {
        docs["dynamic_fields/f1"] = buildJsonObject {
            put("name", str("crate_trained"))
            put("label", str("Crate trained"))
            put("updatedAt", ts("2025-02-02T00:00:00Z"))
            put("legacy", str("a field the desktop model lacks"))
        }
        val loaded = JvmFirestoreRest.getDoc<DynamicField>("dynamic_fields", "f1")!!
        assertEquals(WriteResult.Ok(true), FirestoreClient().updateDynamicField(loaded, loaded.copy(label = "Crate-trained?")))
        assertEquals(WriteResult.Ok(false), FirestoreClient().updateDynamicField(loaded, loaded.copy()))
        assertEquals(listOf<List<String>?>(listOf("label")), masks)
        val doc = stored("dynamic_fields/f1")
        assertEquals(str("Crate-trained?"), doc["label"])
        assertEquals(str("a field the desktop model lacks"), doc["legacy"])
        assertEquals(ts("2025-02-02T00:00:00Z"), doc["updatedAt"])
    }

    // ── vet_clinics: the updateVetClinic callable, never a client write ─────

    private val clinic = VetClinic(
        _id = "v1", name = "Creekside", phone = "555", address = "1 Ln", website = "https://c.example",
        hours = "8-6", notes = "n", isEmergency = false, verified = true, googleMapsUrl = "https://maps", updatedAt = "2025-01-01T00:00:00Z",
    )

    private fun lastPayload(): JsonObject = Json.parseToJsonElement(JvmFirestoreFixtures.lastCallablePayloadJson!!).jsonObject

    @Test
    fun aVetClinicEditGoesThroughTheCallableAndKeepsHours() = runBlocking<Unit> {
        JvmFirestoreFixtures.callableResponses = mapOf("updateVetClinic" to """{"ok":true,"clinicId":"v1","householdCount":2}""")
        val r = FirestoreClient().updateVetClinic(clinic, clinic.copy(phone = "556"))
        assertEquals(WriteResult.Ok(true), r)
        assertEquals("updateVetClinic", JvmFirestoreFixtures.lastCallableName)
        val p = lastPayload()
        assertEquals(
            setOf("clinicId", "name", "phone", "address", "website", "hours", "notes", "isEmergency"),
            p.keys,
            "the callable's whole editable record, and nothing it does not take",
        )
        assertEquals("v1", p["clinicId"]?.jsonPrimitive?.content)
        assertEquals("556", p["phone"]?.jsonPrimitive?.content)
        assertEquals("8-6", p["hours"]?.jsonPrimitive?.content, "hours is carried, so a desktop save never clears it")
        assertEquals(emptyList<List<String>?>(), masks, "no direct vet_clinics write (rules refuse it)")
    }

    @Test
    fun approvingAVetClinicSendsVerified() = runBlocking<Unit> {
        JvmFirestoreFixtures.callableResponses = mapOf("updateVetClinic" to """{"ok":true,"clinicId":"v1","householdCount":0}""")
        val pending = clinic.copy(verified = false, submittedBy = "uid-1")
        FirestoreClient().updateVetClinic(pending, pending.copy(verified = true, submittedBy = ""))
        assertTrue(lastPayload()["verified"]!!.jsonPrimitive.boolean)
        assertFalse("submittedBy" in lastPayload())
    }

    @Test
    fun anUnchangedVetClinicSaveMakesNoCall() = runBlocking<Unit> {
        assertEquals(WriteResult.Ok(false), FirestoreClient().updateVetClinic(clinic, clinic.copy()))
        // A change only to a field the callable cannot take is not a save either.
        assertEquals(WriteResult.Ok(false), FirestoreClient().updateVetClinic(clinic, clinic.copy(googleMapsUrl = "x")))
        assertNull(JvmFirestoreFixtures.lastCallableName)
    }

    @Test
    fun aRefusedVetClinicSaveIsAnError() = runBlocking<Unit> {
        JvmFirestoreFixtures.callableErrors = mapOf("updateVetClinic" to "Another clinic is already called 'Creekside'.")
        val r = FirestoreClient().updateVetClinic(clinic, clinic.copy(phone = "556"))
        assertEquals(WriteResult.Err("Another clinic is already called 'Creekside'."), r)
    }

    // ── #998: vet_clinics create through submitVetClinic, never a client addDoc ─

    @Test
    fun creatingAVetClinicGoesThroughSubmitVetClinicWithWebsPayload() = runBlocking<Unit> {
        JvmFirestoreFixtures.callableResponses =
            mapOf("submitVetClinic" to """{"status":"created","clinicId":"new1","created":true,"pending":false,"candidates":[]}""")
        val draft = VetClinic(name = "  Corner Vet  ", phone = " 555 ", address = " 1 Ln ", website = " https://c.example ", isEmergency = true, notes = "ignored", hours = "ignored")
        val r = FirestoreClient().createVetClinic(draft)
        assertEquals(WriteResult.Ok("new1"), r)
        assertEquals("submitVetClinic", JvmFirestoreFixtures.lastCallableName)
        val p = lastPayload()
        assertEquals(
            setOf("name", "phone", "address", "website", "isEmergency", "acknowledgedMatchIds"),
            p.keys,
            "the same payload admin web sends - no hours, no notes, the callable has no fields for them",
        )
        assertEquals("Corner Vet", p["name"]?.jsonPrimitive?.content, "trimmed")
        assertEquals("555", p["phone"]?.jsonPrimitive?.content)
        assertTrue(p["acknowledgedMatchIds"]!!.jsonArray.isEmpty(), "no near-match picker on this form")
        assertEquals(emptyList<List<String>?>(), masks, "no direct vet_clinics write (rules refuse it)")
    }

    @Test
    fun aNeedsChoiceResponseCreatesNothingAndIsAnError() = runBlocking<Unit> {
        JvmFirestoreFixtures.callableResponses =
            mapOf("submitVetClinic" to """{"status":"needs_choice","clinicId":"","created":false,"pending":false,"candidates":[{"id":"a","name":"Riverside","address":"","phone":"","isEmergency":false,"verified":true,"reason":"name"}]}""")
        val r = FirestoreClient().createVetClinic(VetClinic(name = "Riverside"))
        assertTrue(r is WriteResult.Err, "nothing was written; a needs_choice is not a create")
    }

    @Test
    fun aRefusedVetClinicCreateIsAnError() = runBlocking<Unit> {
        JvmFirestoreFixtures.callableErrors = mapOf("submitVetClinic" to "permission-denied")
        val r = FirestoreClient().createVetClinic(VetClinic(name = "Corner Vet"))
        assertEquals(WriteResult.Err("permission-denied"), r)
    }

    @Test
    fun createWithABlankNameNeverCalls() = runBlocking<Unit> {
        val r = FirestoreClient().createVetClinic(VetClinic(name = "   "))
        assertTrue(r is WriteResult.Err)
        assertNull(JvmFirestoreFixtures.lastCallableName)
    }

    // ── #998: vet_clinics archive/restore through archiveVetClinic, never a client deleteDoc ─

    @Test
    fun retiringAVetClinicGoesThroughArchiveVetClinic() = runBlocking<Unit> {
        JvmFirestoreFixtures.callableResponses = mapOf("archiveVetClinic" to """{"ok":true,"clinicId":"v1","archived":true,"householdCount":2}""")
        val r = FirestoreClient().archiveVetClinic("v1", true)
        assertEquals(WriteResult.Ok(Unit), r)
        assertEquals("archiveVetClinic", JvmFirestoreFixtures.lastCallableName)
        assertEquals(setOf("clinicId", "archived"), lastPayload().keys)
        assertEquals("v1", lastPayload()["clinicId"]?.jsonPrimitive?.content)
        assertTrue(lastPayload()["archived"]!!.jsonPrimitive.boolean)
        assertEquals(emptyList<List<String>?>(), masks, "no direct vet_clinics write (rules refuse it)")
    }

    @Test
    fun restoringAVetClinicSendsArchivedFalse() = runBlocking<Unit> {
        JvmFirestoreFixtures.callableResponses = mapOf("archiveVetClinic" to """{"ok":true,"clinicId":"v1","archived":false,"householdCount":0}""")
        FirestoreClient().archiveVetClinic("v1", false)
        assertFalse(lastPayload()["archived"]!!.jsonPrimitive.boolean)
    }

    @Test
    fun aRefusedArchiveIsAnError() = runBlocking<Unit> {
        JvmFirestoreFixtures.callableErrors = mapOf("archiveVetClinic" to "Clinic 'v1' not found.")
        val r = FirestoreClient().archiveVetClinic("v1", true)
        assertEquals(WriteResult.Err("Clinic 'v1' not found."), r)
    }

    @Test
    fun archiveWithABlankIdNeverCalls() = runBlocking<Unit> {
        val r = FirestoreClient().archiveVetClinic("", true)
        assertTrue(r is WriteResult.Err)
        assertNull(JvmFirestoreFixtures.lastCallableName)
    }

    // ── the shared diff ─────────────────────────────────────────────────────

    @Test
    fun modelChangesNeverNamesIdOrExcludedFields() {
        val changes = modelChanges(VetClinic.serializer(), VetClinic(_id = "a", name = "x"), VetClinic(_id = "b", name = "y", updatedAt = "t"), excluded = setOf("updatedAt"))
        assertEquals(listOf(listOf("name")), changes.map { it.path })
        assertEquals(JsonPrimitive("y"), changes.single().value)
    }
}
