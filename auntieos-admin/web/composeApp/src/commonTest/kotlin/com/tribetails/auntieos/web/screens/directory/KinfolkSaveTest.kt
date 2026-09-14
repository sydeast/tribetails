package com.tribetails.auntieos.web.screens.directory

import com.tribetails.auntieos.web.data.EmergencyContactDraft
import com.tribetails.auntieos.web.data.WriteResult
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class KinfolkSaveTest {

    private class Calls {
        val log = mutableListOf<String>()
    }

    @Test
    fun addWritesTheHouseholdThenTheContacts() = runTest {
        val c = Calls()
        val out = saveKinfolkWithContacts(
            retryKinfolkId = null,
            saveContacts = true,
            writeHousehold = { c.log += "household"; WriteResult.Ok("kf-new") },
            writeContacts = { id -> c.log += "contacts:$id"; WriteResult.Ok(Unit) },
            onHouseholdWritten = { id -> c.log += "audit:$id" },
        )
        assertEquals(KinfolkSaveOutcome.Saved("kf-new"), out)
        assertEquals(listOf("household", "audit:kf-new", "contacts:kf-new"), c.log)
    }

    @Test
    fun aFailedContactSaveKeepsTheNewIdForTheRetry() = runTest {
        val c = Calls()
        val out = saveKinfolkWithContacts(
            retryKinfolkId = null,
            saveContacts = true,
            writeHousehold = { c.log += "household"; WriteResult.Ok("kf-new") },
            writeContacts = { c.log += "contacts"; WriteResult.Err("An Emergency Contact has to be someone outside the household.") },
            onHouseholdWritten = { c.log += "audit" },
        )
        assertEquals(KinfolkSaveOutcome.ContactsFailed("kf-new", "An Emergency Contact has to be someone outside the household."), out)
        assertEquals(listOf("household", "audit", "contacts"), c.log)
    }

    /** #829: the retry after a failed contact save must never create a second household. */
    @Test
    fun theRetrySavesOnlyTheContactsAndNeverWritesTheHousehold() = runTest {
        val c = Calls()
        val out = saveKinfolkWithContacts(
            retryKinfolkId = "kf-new",
            saveContacts = true,
            writeHousehold = { c.log += "household"; WriteResult.Ok("kf-second") },
            writeContacts = { id -> c.log += "contacts:$id"; WriteResult.Ok(Unit) },
            onHouseholdWritten = { c.log += "audit" },
        )
        assertEquals(KinfolkSaveOutcome.Saved("kf-new"), out)
        assertEquals(listOf("contacts:kf-new"), c.log)
    }

    @Test
    fun aFailedRetryStaysOnTheSameHousehold() = runTest {
        val out = saveKinfolkWithContacts(
            retryKinfolkId = "kf-new",
            saveContacts = true,
            writeHousehold = { error("must not be called") },
            writeContacts = { WriteResult.Err("offline") },
            onHouseholdWritten = { error("must not be called") },
        )
        assertEquals(KinfolkSaveOutcome.ContactsFailed("kf-new", "offline"), out)
    }

    @Test
    fun aFailedHouseholdWriteNeverSavesContacts() = runTest {
        val c = Calls()
        val out = saveKinfolkWithContacts(
            retryKinfolkId = null,
            saveContacts = true,
            writeHousehold = { WriteResult.Err("Firestore write 403") },
            writeContacts = { c.log += "contacts"; WriteResult.Ok(Unit) },
            onHouseholdWritten = { c.log += "audit" },
        )
        assertEquals(KinfolkSaveOutcome.HouseholdFailed("Firestore write 403"), out)
        assertTrue(c.log.isEmpty())
    }

    @Test
    fun anEditThatLeavesTheContactsAloneDoesNotCallTheCallable() = runTest {
        val c = Calls()
        val out = saveKinfolkWithContacts(
            retryKinfolkId = null,
            saveContacts = false,
            writeHousehold = { c.log += "household"; WriteResult.Ok("kf1") },
            writeContacts = { c.log += "contacts"; WriteResult.Ok(Unit) },
            onHouseholdWritten = {},
        )
        assertEquals(KinfolkSaveOutcome.Saved("kf1"), out)
        assertEquals(listOf("household"), c.log)
    }

    @Test
    fun whenContactsNeedSaving() {
        val blank = listOf(EmergencyContactDraft())
        val rae = listOf(EmergencyContactDraft("Rae", "8055550199"))
        assertTrue(emergencyContactsNeedSaving(isNew = true, drafts = blank, baseline = blank), "Add always saves (and validates) them")
        assertFalse(emergencyContactsNeedSaving(isNew = false, drafts = rae, baseline = rae), "unchanged")
        assertTrue(emergencyContactsNeedSaving(isNew = false, drafts = listOf(EmergencyContactDraft("Rae", "8055550100")), baseline = rae), "changed")
        assertFalse(emergencyContactsNeedSaving(isNew = false, drafts = blank, baseline = blank), "none on file and still none: the flag, not a block")
        assertTrue(emergencyContactsNeedSaving(isNew = false, drafts = rae, baseline = blank), "adding one to a flagged household")
        assertTrue(emergencyContactsNeedSaving(isNew = false, drafts = blank, baseline = rae), "clearing them is sent, and refused")
    }
}
