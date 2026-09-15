package com.tribetails.auntieos.web.screens.directory

import com.tribetails.auntieos.web.data.Kinfolk
import com.tribetails.auntieos.web.data.WriteResult
import kotlinx.coroutines.test.runTest
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** #907 review items 1 and 2, on the pure save sequence and the app-level stores. */
class KinfolkSaveDuplicateTest {

    @AfterTest
    fun tearDown() = PendingAddKinfolk.clearAll()

    @Test
    fun aDuplicateOfAnswerStopsTheSaveWithNoContactWriteAndNoAudit() = runTest {
        var contactsWritten = false
        var audited = false
        val out = saveKinfolkWithContacts(
            retryKinfolkId = null,
            saveContacts = true,
            writeHousehold = { WriteResult.Ok(HouseholdWrite("kf-existing", wrote = false, duplicateOf = "kf-existing")) },
            writeContacts = { contactsWritten = true; WriteResult.Ok(Unit) },
            onHouseholdWritten = { audited = true },
        )
        assertEquals(KinfolkSaveOutcome.Duplicate("kf-existing"), out)
        assertFalse(contactsWritten, "a duplicate saved its contact onto the existing household")
        assertFalse(audited)
    }

    @Test
    fun aDeletedHouseholdIsReportedAsGoneOnTheFirstSaveAndOnTheRetry() = runTest {
        val first = saveKinfolkWithContacts(
            retryKinfolkId = null,
            saveContacts = true,
            writeHousehold = { WriteResult.Ok(HouseholdWrite("kf-new")) },
            writeContacts = { WriteResult.Err(HOUSEHOLD_NO_LONGER_EXISTS) },
            onHouseholdWritten = {},
        )
        assertEquals(KinfolkSaveOutcome.HouseholdGone("kf-new"), first)

        val retry = saveKinfolkWithContacts(
            retryKinfolkId = "kf-new",
            saveContacts = true,
            writeHousehold = { error("a retry never writes the household") },
            writeContacts = { WriteResult.Err(HOUSEHOLD_NO_LONGER_EXISTS) },
            onHouseholdWritten = {},
        )
        assertEquals(KinfolkSaveOutcome.HouseholdGone("kf-new"), retry)
        assertEquals(HOUSEHOLD_NO_LONGER_EXISTS, contactErrorAfterSave(retry, isNew = true, contactProblem = null))
    }

    @Test
    fun theDiscardedHouseholdIsKeptPerOperatorUntilCleared() {
        PendingAddKinfolk.discard("op-1", "kf-left")
        assertEquals("kf-left", PendingAddKinfolk.discardedFor("op-1"))
        assertNull(PendingAddKinfolk.discardedFor("op-2"))
        PendingAddKinfolk.clearDiscarded("op-1")
        assertNull(PendingAddKinfolk.discardedFor("op-1"))
    }

    @Test
    fun aDuplicateAddIsHandedOnlyToItsHouseholdAndOperator() {
        val typed = PendingKinfolk("kf-existing", Kinfolk(firstName = "Dana"), emptyList())
        PendingAddKinfolk.keepDuplicate("op-1", typed)
        assertEquals(typed, PendingAddKinfolk.duplicateFor("op-1", "kf-existing"))
        assertNull(PendingAddKinfolk.duplicateFor("op-1", "kf-other"))
        assertNull(PendingAddKinfolk.duplicateFor("op-2", "kf-existing"))
        PendingAddKinfolk.clearDuplicate("op-1")
        assertNull(PendingAddKinfolk.duplicateFor("op-1", "kf-existing"))
    }

    @Test
    fun theOverlayTakesOnlyTypedValuesThatDifferAndNeverABlank() {
        val stored = Kinfolk(
            _id = "kf1", firstName = "Dana", lastName = "Mercer", phoneNumber = "8055550100",
            email = "dana@example.com", serviceAddress = "12 Oak", gateCode = "1234",
            formValues = mapOf("petName" to "Biscuit"),
        )
        val typed = Kinfolk(
            firstName = "Dana ", lastName = "Mercer-Park", phoneNumber = "", email = "dana@example.com",
            serviceAddress = "99 Elm", gateCode = "", formValues = mapOf("petName" to "", "treat" to "Kibble"),
        )
        val out = overlayDuplicateAdd(stored, typed)
        assertEquals("Dana", out.firstName)
        assertEquals("Mercer-Park", out.lastName)
        assertEquals("8055550100", out.phoneNumber)
        assertEquals("99 Elm", out.serviceAddress)
        assertEquals("1234", out.gateCode)
        assertEquals(mapOf("petName" to "Biscuit", "treat" to "Kibble"), out.formValues)
        assertEquals("kf1", out._id)
    }

    @Test
    fun theNoticeNamesTheStoredHouseholdAndAStatusItCannotChange() {
        val stored = Kinfolk(firstName = "Dana", lastName = "Mercer", status = "active")
        assertEquals(
            "Dana Mercer was already added a few minutes ago. What you typed in Add that differs is filled in below and is not saved yet.",
            duplicateAddNotice(stored, Kinfolk(status = "active")),
        )
        assertTrue(duplicateAddNotice(stored, Kinfolk(status = "prospect")).endsWith("Status on Add was prospect; this household is active, and status is not changed here."))
    }
}
