package com.tribetails.auntieos.web.screens.directory

import com.tribetails.auntieos.web.data.EmergencyContactDraft
import com.tribetails.auntieos.web.data.WriteResult
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
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
            writeHousehold = { c.log += "household"; WriteResult.Ok(HouseholdWrite("kf-new")) },
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
            writeHousehold = { c.log += "household"; WriteResult.Ok(HouseholdWrite("kf-new")) },
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
            writeHousehold = { c.log += "household"; WriteResult.Ok(HouseholdWrite("kf-second")) },
            writeContacts = { id -> c.log += "contacts:$id"; WriteResult.Ok(Unit) },
            onHouseholdWritten = { c.log += "audit" },
        )
        assertEquals(KinfolkSaveOutcome.Saved("kf-new"), out)
        assertEquals(listOf("contacts:kf-new"), c.log)
    }

    /**
     * #858: Edit has no second id to create, so `KinfolkEditScreen.onSave` reuses
     * this household's OWN id as `retryKinfolkId` once its household has saved and
     * only the contact is left (`editContactRetryPending`). Proven here against a
     * [writeHousehold] that does more than the household field diff: the real one
     * also upserts a typed vet clinic into the shared catalog before it ever
     * checks whether any household field actually changed, so skipping the whole
     * lambda - not just the merge write inside it - is what keeps a retry from
     * creating a second clinic row. If this regresses to only skipping the
     * network write and not the call, this test fails on the clinic log entry,
     * not just the household one.
     */
    @Test
    fun anEditRetryReusesTheHouseholdsOwnIdAndNeverReRunsWriteHousehold() = runTest {
        val c = Calls()
        val out = saveKinfolkWithContacts(
            retryKinfolkId = "kf1",
            saveContacts = true,
            writeHousehold = {
                c.log += "vet-clinic-upsert"
                c.log += "household"
                WriteResult.Ok(HouseholdWrite("kf1"))
            },
            writeContacts = { id -> c.log += "contacts:$id"; WriteResult.Ok(Unit) },
            onHouseholdWritten = { c.log += "audit" },
        )
        assertEquals(KinfolkSaveOutcome.Saved("kf1"), out)
        assertEquals(listOf("contacts:kf1"), c.log, "writeHousehold, and everything inside it, must not run on the retry")
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
            writeHousehold = { c.log += "household"; WriteResult.Ok(HouseholdWrite("kf1")) },
            writeContacts = { c.log += "contacts"; WriteResult.Ok(Unit) },
            onHouseholdWritten = { c.log += "audit" },
        )
        assertEquals(KinfolkSaveOutcome.Saved("kf1"), out)
        assertEquals(listOf("household", "audit"), c.log)
    }

    /** #829 review: an edit whose diff is empty writes nothing, so nothing is audited. */
    @Test
    fun anEmptyEditIsNotAudited() = runTest {
        val c = Calls()
        val out = saveKinfolkWithContacts(
            retryKinfolkId = null,
            saveContacts = false,
            writeHousehold = { c.log += "household"; WriteResult.Ok(HouseholdWrite("kf1", wrote = false)) },
            writeContacts = { c.log += "contacts"; WriteResult.Ok(Unit) },
            onHouseholdWritten = { c.log += "audit" },
        )
        assertEquals(KinfolkSaveOutcome.Saved("kf1"), out)
        assertEquals(listOf("household"), c.log)
    }

    @Test
    fun anEmptyEditStillSavesChangedContactsWithoutAnAudit() = runTest {
        val c = Calls()
        saveKinfolkWithContacts(
            retryKinfolkId = null,
            saveContacts = true,
            writeHousehold = { WriteResult.Ok(HouseholdWrite("kf1", wrote = false)) },
            writeContacts = { id -> c.log += "contacts:$id"; WriteResult.Ok(Unit) },
            onHouseholdWritten = { c.log += "audit" },
        )
        assertEquals(listOf("contacts:kf1"), c.log)
    }

    /** #858: which id, if any, [KinfolkEditScreen.onSave] retries against. */
    @Test
    fun kinfolkRetryIdPrefersACreatedHouseholdThenFallsToEditsOwnId() {
        // Add: nothing created yet, or a normal Edit - no retry.
        assertNull(kinfolkRetryId(createdKinfolkId = null, isNew = true, kinfolkId = null, editContactRetryPending = false))
        assertNull(kinfolkRetryId(createdKinfolkId = null, isNew = false, kinfolkId = "kf1", editContactRetryPending = false))
        // Add retry: its created id, regardless of Edit's own flag (which Add never sets).
        assertEquals("kf-new", kinfolkRetryId(createdKinfolkId = "kf-new", isNew = true, kinfolkId = null, editContactRetryPending = false))
        // Edit retry: this screen's own id, only once its flag is set.
        assertEquals("kf1", kinfolkRetryId(createdKinfolkId = null, isNew = false, kinfolkId = "kf1", editContactRetryPending = true))
        // Edit's flag alone is never enough without an id, and never fires on Add.
        assertNull(kinfolkRetryId(createdKinfolkId = null, isNew = false, kinfolkId = null, editContactRetryPending = true))
        assertNull(kinfolkRetryId(createdKinfolkId = null, isNew = true, kinfolkId = "kf1", editContactRetryPending = true))
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

    /** #829 review: stray whitespace on file is not an edit. */
    @Test
    fun aTrimmedFieldKeepsTheStoredValueUnlessEdited() {
        assertEquals("1234 ", keepStoredUnlessEdited("1234 ", "1234 "), "opened with no edit: stored value stands")
        assertEquals("1234 ", keepStoredUnlessEdited("1234", "1234 "), "only whitespace differs: not an edit")
        assertEquals("9999", keepStoredUnlessEdited(" 9999 ", "1234 "), "a real edit saves trimmed")
        assertEquals("Dana", keepStoredUnlessEdited(" Dana ", ""), "a new value saves trimmed")
    }
}
