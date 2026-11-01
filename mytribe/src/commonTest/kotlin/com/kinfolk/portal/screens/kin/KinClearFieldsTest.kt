package com.kinfolk.portal.screens.kin

import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.portal.Kin
import com.kinfolk.portal.portal.KinPayload
import com.kinfolk.portal.portal.KinStatus
import com.kinfolk.portal.portal.PortalApi
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * #1336: emptying a Kin field on Android and saving must clear it on the
 * server. Before, a blank became a null that `kinPayloadToJson` never sent, so
 * `updateKin`'s merge kept the old value.
 */
class KinClearFieldsTest {

    private val stored = Kin(
        id = "k1", name = "Buddy", species = "Dog", breed = "Beagle", ageYears = 2.5, photoUrl = null,
        status = KinStatus.Active, feedingInstructions = "1 cup", walkingInstructions = "Twice",
        medications = "Apoquel", allergies = "Chicken", emergencyNotes = "Call Sam", sitterNotes = "Shy",
        sex = "Male", weight = "30 lbs", colorMarkings = "Tri", spayedNeutered = true, vetInfo = "Dr A",
    )

    /** The form exactly as the dialog seeds it from [stored]. */
    private fun untouched() = kinCareFieldsPayload(
        initial = stored,
        name = "Buddy",
        species = "Dog",
        breed = "Beagle",
        ageText = ageSeedText(stored.ageYears),
        feed = "1 cup",
        walk = "Twice",
        meds = "Apoquel",
        allergies = "Chicken",
        emergency = "Call Sam",
        sitter = "Shy",
    )

    private suspend fun sentKin(payload: KinPayload): JsonObject {
        val fake = FakeFunctionsClient()
        fake.stub("updateKin", buildJsonObject { put("ok", true) })
        PortalApi(fake).updateKin(kinId = "k1", kin = payload)
        val (name, args) = fake.calls.single()
        assertEquals("updateKin", name)
        return args!!["kin"]!!.jsonObject
    }

    @Test
    fun `an untouched form sends only the name`() = runTest {
        val sent = sentKin(untouched())
        assertEquals(setOf("name"), sent.keys)
    }

    @Test
    fun `a stored fractional age the form shows rounded is not rewritten`() {
        // The dialog shows 2.5 as "2". Rebuilding from the form used to send 2.0.
        val p = untouched()
        assertEquals(null, p.ageYears)
        assertFalse("ageYears" in p.clearFields)
    }

    @Test
    fun `an emptied medication is sent as JSON null and the rest are not sent`() = runTest {
        val sent = sentKin(
            kinCareFieldsPayload(
                initial = stored, name = "Buddy", species = "Dog", breed = "Beagle",
                ageText = "2", feed = "1 cup", walk = "Twice", meds = "   ",
                allergies = "Chicken", emergency = "Call Sam", sitter = "Shy",
            ),
        )
        assertEquals(JsonNull, sent["medications"])
        assertEquals(setOf("name", "medications"), sent.keys)
    }

    @Test
    fun `every parent-owned field emptied goes as null, age included`() = runTest {
        val p = kinCareFieldsPayload(
            initial = stored, name = "Buddy", species = "", breed = "", ageText = "",
            feed = "", walk = "", meds = "", allergies = "", emergency = "", sitter = "",
        )
        val sent = sentKin(p)
        for (key in listOf(
            "species", "breed", "ageYears", "feedingInstructions", "walkingInstructions",
            "medications", "allergies", "emergencyNotes", "sitterNotes",
        )) {
            assertEquals(JsonNull, sent[key], "$key should be sent as null")
        }
        assertFalse(sent.containsKey("photoUrl"), "the dialog never clears the photo through this path")
    }

    @Test
    fun `a changed field carries its trimmed value`() = runTest {
        val p = kinCareFieldsPayload(
            initial = stored, name = "Buddy", species = "Dog", breed = " Basset ", ageText = "4",
            feed = "1 cup", walk = "Twice", meds = "Apoquel", allergies = "Chicken", emergency = "Call Sam", sitter = "Shy",
        )
        val sent = sentKin(p)
        assertEquals("Basset", sent["breed"]!!.jsonPrimitive.content)
        assertEquals(4.0, sent["ageYears"]!!.jsonPrimitive.doubleOrNull)
        assertEquals(setOf("name", "breed", "ageYears"), sent.keys)
    }

    @Test
    fun `an age that does not parse is left alone, not cleared`() {
        val p = kinCareFieldsPayload(
            initial = stored, name = "Buddy", species = "Dog", breed = "Beagle", ageText = "two",
            feed = "1 cup", walk = "Twice", meds = "Apoquel", allergies = "Chicken", emergency = "Call Sam", sitter = "Shy",
        )
        assertEquals(null, p.ageYears)
        assertFalse("ageYears" in p.clearFields)
    }

    @Test
    fun `adding a kin sends what was filled in and clears nothing`() = runTest {
        val p = kinCareFieldsPayload(
            initial = null, name = "Rex", species = "Dog", breed = "", ageText = "",
            feed = "", walk = "", meds = "Pill", allergies = "", emergency = "", sitter = "",
        )
        assertTrue(p.clearFields.isEmpty())
        val fake = FakeFunctionsClient()
        fake.stub("addKin", buildJsonObject { put("kinId", "new") })
        PortalApi(fake).addKin(kin = p)
        val sent = fake.calls.single().second!!["kin"]!!.jsonObject
        assertEquals(setOf("name", "species", "medications"), sent.keys)
    }

    @Test
    fun `a shared fact cannot be cleared with null, only with an empty string`() = runTest {
        // The server refuses null for the five shared facts (#1310); a stray key
        // in clearFields must not put one on the wire.
        val sent = sentKin(KinPayload(name = "Buddy", weight = "", clearFields = setOf("sex", "medications")))
        assertFalse(sent.containsKey("sex"))
        assertEquals("", sent["weight"]!!.jsonPrimitive.content)
        assertEquals(JsonNull, sent["medications"])
    }

    @Test
    fun `the shared facts and the care fields combine in one save`() = runTest {
        val care = kinCareFieldsPayload(
            initial = stored, name = "Buddy", species = "Dog", breed = "Beagle", ageText = "2",
            feed = "1 cup", walk = "Twice", meds = "Apoquel", allergies = "", emergency = "Call Sam", sitter = "Shy",
        )
        val facts = sharedFactsPayload(stored, sex = "Male", weight = "", markings = "Tri", fixed = true, vet = "Dr A")
        val sent = sentKin(care.copy(weight = facts.weight))
        assertEquals(JsonNull, sent["allergies"])
        assertEquals("", sent["weight"]!!.jsonPrimitive.content)
        assertEquals(setOf("name", "allergies", "weight"), sent.keys)
    }
}
