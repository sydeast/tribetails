package com.tribetails.auntieos.web.screens.directory

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #829 review items 4 and 14: what Edit and Add Kinfolk do with a contact problem.
 * The operator ruling is that the No Emergency Contact flag never blocks other
 * edits, while Add still creates a household only with its contact.
 */
class KinfolkContactGateTest {

    private val phoneMissing = "An Emergency Contact needs a phone number."

    @Test
    fun aContactProblemBlocksAddAndAnAddRetryButNeverEdit() {
        assertTrue(contactBlocksSave(isNew = true, retryKinfolkId = null, contactProblem = phoneMissing))
        assertTrue(contactBlocksSave(isNew = true, retryKinfolkId = "kf-new", contactProblem = phoneMissing))
        assertFalse(contactBlocksSave(isNew = false, retryKinfolkId = null, contactProblem = phoneMissing))
        assertFalse(contactBlocksSave(isNew = true, retryKinfolkId = null, contactProblem = null))
    }

    @Test
    fun anEditThatSavedTheHouseholdKeepsTheContactProblemOnTheEditor() {
        assertEquals(phoneMissing, contactErrorAfterSave(KinfolkSaveOutcome.Saved("kf1"), isNew = false, contactProblem = phoneMissing))
        assertNull(contactErrorAfterSave(KinfolkSaveOutcome.Saved("kf1"), isNew = false, contactProblem = null))
        assertNull(contactErrorAfterSave(KinfolkSaveOutcome.HouseholdFailed("offline"), isNew = false, contactProblem = phoneMissing))
    }

    @Test
    fun aRefusedContactSaveShowsTheServerMessageWithNoPrefix() {
        val refused = "An Emergency Contact has to be someone outside the household."
        assertEquals(refused, contactErrorAfterSave(KinfolkSaveOutcome.ContactsFailed("kf1", refused), isNew = false, contactProblem = null))
        val onAdd = contactErrorAfterSave(KinfolkSaveOutcome.ContactsFailed("kf-new", refused), isNew = true, contactProblem = null)
        assertEquals("$refused The household was created and shows No Emergency Contact until this is saved.", onAdd)
        assertFalse(onAdd.orEmpty().contains("saveEmergencyContacts failed"))
    }
}
