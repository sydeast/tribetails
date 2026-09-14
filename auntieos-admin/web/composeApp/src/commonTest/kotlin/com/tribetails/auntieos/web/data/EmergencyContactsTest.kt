package com.tribetails.auntieos.web.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class EmergencyContactsTest {

    @Test
    fun readsTheArrayInCallOrderThenTheFlatFallback() {
        val arr = buildJsonArray {
            add(buildJsonObject { put("name", "Rae Mercer"); put("phone", "+18055550199"); put("relationship", "Sister"); put("recordedAt", "2026-03-02T10:00:00Z") })
            add(buildJsonObject { put("name", "Lee Park"); put("phone", "+18055550177"); put("relationship", JsonNull) })
        }
        val withArray = Kinfolk(emergencyContacts = arr, emergencyContactName = "Old")
        assertEquals(listOf("Rae Mercer", "Lee Park"), emergencyContactsOf(withArray).map { it.name })
        assertNull(emergencyContactsOf(withArray)[1].relationship)

        val legacy = Kinfolk(emergencyContactName = "Rae", emergencyContactPhone = "805")
        assertEquals(listOf(EmergencyContact("Rae", "805", null, null, null)), emergencyContactsOf(legacy))
        assertTrue(emergencyContactsOf(Kinfolk()).isEmpty())
    }

    /**
     * #829: every desktop kinfolk write (create body and update mask) goes through
     * kinfolkWriteJson. None of the four Emergency Contact keys may be in it: the
     * array belongs to the saveEmergencyContacts callable, and a create must not
     * write the three flat keys either, not even blank.
     */
    @Test
    fun theWriteBodyNeverCarriesAnyEmergencyContactKey() {
        val k = Kinfolk(
            _id = "kf1",
            firstName = "Dana",
            emergencyContacts = buildJsonArray { add(buildJsonObject { put("name", "Rae") }) },
            emergencyContactName = "Rae",
            emergencyContactPhone = "8055550199",
            emergencyContactRelation = "Sister",
        )
        val body = Json.parseToJsonElement(kinfolkWriteJson(k)).jsonObject
        for (key in KINFOLK_WRITE_EXCLUDED_KEYS) assertFalse(key in body, "$key must not be written")
        assertEquals(
            setOf("emergencyContacts", "emergencyContactName", "emergencyContactPhone", "emergencyContactRelation"),
            KINFOLK_WRITE_EXCLUDED_KEYS,
        )
        assertEquals("Dana", body["firstName"].toString().trim('"'))
        assertTrue("serviceAddress" in body, "every other model field is still written")
    }

    @Test
    fun validationMirrorsTheServer() {
        val names = listOf("Dana Mercer")
        val phones = listOf("(805) 555-0100")
        assertEquals("A household needs at least one Emergency Contact", validateEmergencyContactDrafts(listOf(EmergencyContactDraft()), names, phones))
        assertEquals("An Emergency Contact has to be someone outside the household.", validateEmergencyContactDrafts(listOf(EmergencyContactDraft("Rae", "8055550100")), names, phones))
        assertEquals("An Emergency Contact has to be someone outside the household.", validateEmergencyContactDrafts(listOf(EmergencyContactDraft(" dana  MERCER ", "8055550199")), names, phones))
        assertEquals("Each Emergency Contact needs a phone number.", validateEmergencyContactDrafts(listOf(EmergencyContactDraft("Rae", "")), names, phones))
        assertEquals("The two Emergency Contacts need different phone numbers.", validateEmergencyContactDrafts(listOf(EmergencyContactDraft("Rae", "8055550199"), EmergencyContactDraft("Lee", "+1 805 555 0199")), names, phones))
        assertNull(validateEmergencyContactDrafts(listOf(EmergencyContactDraft("Rae", "8055550199")), names, phones))
    }

    @Test
    fun draftsHelpers() {
        assertEquals(listOf(EmergencyContactDraft()), emptyList<EmergencyContact>().toDrafts())
        assertTrue(listOf(EmergencyContactDraft(" ", "", "")).isBlankDrafts())
        assertTrue(draftsEqual(listOf(EmergencyContactDraft("Rae ", "805")), listOf(EmergencyContactDraft("Rae", " 805"))))
        assertFalse(draftsEqual(listOf(EmergencyContactDraft("Rae", "805")), listOf(EmergencyContactDraft("Rae", "805"), EmergencyContactDraft())))
    }
}
