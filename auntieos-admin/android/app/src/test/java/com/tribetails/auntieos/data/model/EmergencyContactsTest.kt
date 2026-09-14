package com.tribetails.auntieos.data.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EmergencyContactsTest {

    private val household = listOf("Dana Mercer") to listOf("(805) 555-0100")

    @Test
    fun `reads the array in call order`() {
        val k = Kinfolk(
            emergencyContacts = listOf(
                mapOf("name" to "Rae Mercer", "phone" to "+18055550199", "relationship" to "Sister"),
                mapOf("name" to "Lee Park", "phone" to "+18055550177", "relationship" to null),
            ),
        )
        assertEquals(listOf("Rae Mercer", "Lee Park"), emergencyContactsOf(k).map { it.name })
        assertNull(emergencyContactsOf(k)[1].relationship)
    }

    @Test
    fun `falls back to the flat triple until the migration is verified`() {
        val k = Kinfolk(emergencyContactName = "Rae", emergencyContactPhone = "805", emergencyContactRelation = "")
        assertEquals(listOf(EmergencyContact("Rae", "805", null, null, null)), emergencyContactsOf(k))
        assertTrue(emergencyContactsOf(Kinfolk()).isEmpty())
    }

    @Test
    fun `a malformed stored value reads as none instead of crashing the profile`() {
        assertTrue(emergencyContactsOf(Kinfolk(emergencyContacts = "not a list")).isEmpty())
    }

    @Test
    fun `validation mirrors the server`() {
        val (names, phones) = household
        assertEquals(EMERGENCY_CONTACT_REQUIRED, validateEmergencyContactDrafts(listOf(EmergencyContactDraft()), names, phones))
        assertEquals("A household needs at least one Emergency Contact.", EMERGENCY_CONTACT_REQUIRED)
        assertEquals("An Emergency Contact needs a phone number.", validateEmergencyContactDrafts(listOf(EmergencyContactDraft(name = "Rae")), names, phones))
        assertEquals("An Emergency Contact needs a name.", validateEmergencyContactDrafts(listOf(EmergencyContactDraft(phone = "8055550199")), names, phones))
        assertEquals(
            "An Emergency Contact's name can be at most 80 characters.",
            validateEmergencyContactDrafts(listOf(EmergencyContactDraft("R".repeat(81), "8055550199")), names, phones),
        )
        assertEquals(
            "An Emergency Contact's phone number can be at most 32 characters.",
            validateEmergencyContactDrafts(listOf(EmergencyContactDraft("Rae", "8".repeat(33))), names, phones),
        )
        assertEquals(
            "A relationship can be at most 40 characters.",
            validateEmergencyContactDrafts(listOf(EmergencyContactDraft("Rae", "8055550199", "S".repeat(41))), names, phones),
        )
        assertEquals(
            "The two Emergency Contacts need different phone numbers.",
            validateEmergencyContactDrafts(listOf(EmergencyContactDraft("Rae", "8055550199"), EmergencyContactDraft("Lee", "(805) 555-0199")), names, phones),
        )
        assertEquals(EMERGENCY_CONTACT_OUTSIDE, validateEmergencyContactDrafts(listOf(EmergencyContactDraft("Rae", "+1 805 555 0100")), names, phones))
        assertEquals(EMERGENCY_CONTACT_OUTSIDE, validateEmergencyContactDrafts(listOf(EmergencyContactDraft(" dana  MERCER", "8055550199")), names, phones))
        assertNull(validateEmergencyContactDrafts(listOf(EmergencyContactDraft("Rae", "8055550199")), names, phones))
    }

    @Test
    fun `decode refuses a payload with no contacts array`() {
        val err = runCatching { decodeEmergencyContacts(emptyMap()) }.exceptionOrNull()
        assertTrue(err?.message.orEmpty().contains("no contacts array"))
    }
}
