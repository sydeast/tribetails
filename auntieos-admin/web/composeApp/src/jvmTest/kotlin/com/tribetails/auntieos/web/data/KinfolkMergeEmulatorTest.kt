package com.tribetails.auntieos.web.data

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assume.assumeTrue
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * #829: the desktop kinfolk merge writes against a REAL Firestore (the emulator),
 * not a fake. The unit tests pin the mask and body [JvmFirestoreRest] builds;
 * only a real server can say whether `formValues.<key>` paths, a quoted key with
 * a dot in it, and a delete-by-omission do what the mask grammar promises.
 *
 * Skipped unless `FIRESTORE_EMULATOR_HOST` is set. Run it with:
 *   cd auntieos-admin/web && firebase emulators:exec --only firestore --project auntieos-ttpc \
 *     "./gradlew :composeApp:jvmTest --no-daemon --rerun --tests '*KinfolkMergeEmulatorTest'"
 */
class KinfolkMergeEmulatorTest {

    @BeforeTest
    fun requireEmulator() {
        assumeTrue(
            "FIRESTORE_EMULATOR_HOST is not set; this test only runs against the emulator",
            !System.getenv("FIRESTORE_EMULATOR_HOST").isNullOrBlank(),
        )
        JvmFirestoreFixtures.kinfolk = null
    }

    private fun newId(tag: String) = "ec829-$tag-${System.nanoTime()}"

    /** A household as the office and the portal leave it: model fields, a field the model does not carry, and Emergency Contacts. */
    private suspend fun seed(id: String) {
        JvmFirestoreRest.setDoc(
            "kinfolk",
            id,
            """
            {"firstName":"Ada","lastName":"Moss","status":"active",
             "formValues":{"pet.name":"Rex","a":"1","keep":"k"},
             "portalOnly":"untouched",
             "emergencyContacts":[{"name":"Rae Halbrook","phone":"+15125550190","relationship":null}]}
            """.trimIndent(),
        )
    }

    private suspend fun read(id: String): JsonObject = requireNotNull(JvmFirestoreRest.getDocPlain("kinfolk", id))
    private fun JsonObject.str(key: String) = this[key]?.jsonPrimitive?.content
    private fun JsonObject.form() = this["formValues"]!!.jsonObject

    @Test
    fun aQuotedKeyWithADotIsWrittenAsOneKeyAndItsSiblingsSurvive() = runBlocking {
        val id = newId("dot")
        seed(id)
        JvmFirestoreRest.mergeFieldChanges("kinfolk", id, listOf(KinfolkFieldChange(listOf("formValues", "pet.name"), JsonPrimitive("Max"))))
        val doc = read(id)
        assertEquals("Max", doc.form()["pet.name"]?.jsonPrimitive?.content)
        assertFalse(doc.form().containsKey("pet"), "a dotted key must not become a nested map")
        assertEquals("1", doc.form()["a"]?.jsonPrimitive?.content)
        assertEquals("k", doc.form()["keep"]?.jsonPrimitive?.content)
        assertEquals("Ada", doc.str("firstName"))
        assertEquals("untouched", doc.str("portalOnly"))
        assertEquals(1, doc["emergencyContacts"]!!.jsonArray.size)
    }

    @Test
    fun aDeleteOnlyChangeRemovesThatKeyAndNothingElse() = runBlocking {
        val id = newId("del")
        seed(id)
        JvmFirestoreRest.mergeFieldChanges("kinfolk", id, listOf(KinfolkFieldChange(listOf("formValues", "a"), null)))
        val doc = read(id)
        assertFalse(doc.form().containsKey("a"))
        assertEquals("k", doc.form()["keep"]?.jsonPrimitive?.content)
        assertEquals("Rex", doc.form()["pet.name"]?.jsonPrimitive?.content)
        assertEquals("Ada", doc.str("firstName"))
        assertEquals("untouched", doc.str("portalOnly"))
        assertEquals(1, doc["emergencyContacts"]!!.jsonArray.size)
    }

    @Test
    fun updateKinfolkWritesOnlyWhatChangedSoAConcurrentEditAndEmergencyContactsSurvive() = runBlocking {
        val id = newId("upd")
        seed(id)
        val loaded = requireNotNull(JvmFirestoreRest.getDoc<Kinfolk>("kinfolk", id))
        // Another admin changes firstName after this desktop read the record.
        assertTrue(JvmFirestoreRest.patchFields("kinfolk", id, mapOf("firstName" to JsonPrimitive("Changed"))))

        val edited = loaded.copy(
            lastName = "Lee",
            formValues = loaded.formValues - "keep" + ("new key" to "v"),
        )
        val r = FirestoreClient().updateKinfolk(loaded, edited)
        assertTrue(r is WriteResult.Ok && r.value, "expected a write, got $r")

        val doc = read(id)
        assertEquals("Lee", doc.str("lastName"))
        assertEquals("Changed", doc.str("firstName"), "a field this save did not change must not be put back")
        assertEquals("untouched", doc.str("portalOnly"))
        assertEquals("Rae Halbrook", doc["emergencyContacts"]!!.jsonArray.single().jsonObject["name"]?.jsonPrimitive?.content)
        assertFalse(doc.form().containsKey("keep"))
        assertEquals("v", doc.form()["new key"]?.jsonPrimitive?.content)
        assertEquals("Rex", doc.form()["pet.name"]?.jsonPrimitive?.content)
        assertEquals("1", doc.form()["a"]?.jsonPrimitive?.content)

        val again = FirestoreClient().updateKinfolk(edited, edited)
        assertTrue(again is WriteResult.Ok && !again.value, "an unchanged save writes nothing")
    }
}
