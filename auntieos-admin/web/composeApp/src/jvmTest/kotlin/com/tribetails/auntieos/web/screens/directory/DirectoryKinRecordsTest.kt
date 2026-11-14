package com.tribetails.auntieos.web.screens.directory

import com.tribetails.auntieos.web.data.EmergencyContactDraft
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.Kin
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.data.kinChanges
import com.tribetails.auntieos.web.data.kinfolkRestoredMessage
import com.tribetails.auntieos.web.data.restoredKinfolkStatusFrom
import kotlinx.coroutines.runBlocking
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The desktop console's half of the Directory and Kin records drain:
 * #1902 (an archived Kin can be listed again), #1958 (a restore gives back the
 * status the household held), #1951 (phone and email say what is wrong beside
 * the field) and #2115 (a Kin save never moves its link to the household copy).
 */
class DirectoryKinRecordsTest {
    @AfterTest
    fun tearDown() = JvmFirestoreFixtures.clear()

    // ── #1902 ────────────────────────────────────────────────────────────────

    private val roster = listOf(
        Kin(_id = "a", name = "Biscuit", status = "active"),
        Kin(_id = "b", name = "Gravy", status = "archived"),
        Kin(_id = "c", name = "Pepper", status = " Archived "),
        Kin(_id = "d", name = "Sleepy", status = "inactive"),
    )

    @Test
    fun showOffersAllKinInCareAndArchived() {
        assertEquals(listOf("All kin", "In care", "Archived"), KinShow.entries.map { it.label })
    }

    @Test
    fun allKinLeavesArchivedOutAndArchivedListsOnlyThem() {
        assertEquals(listOf("a", "d"), kinForShow(roster, "", KinShow.All).map { it._id })
        assertEquals(listOf("a"), kinForShow(roster, "", KinShow.InCare).map { it._id })
        assertEquals(listOf("b", "c"), kinForShow(roster, "", KinShow.Archived).map { it._id })
        assertEquals(listOf("b"), kinForShow(roster, "grav", KinShow.Archived).map { it._id })
    }

    @Test
    fun theEmptyStateNamesTheShowChoice() {
        assertEquals("No archived Kin", kinShowEmptyText("", KinShow.Archived, anyOnFile = true).first)
        assertEquals("Every Kin on file is archived", kinShowEmptyText("", KinShow.All, anyOnFile = true).first)
        assertEquals("No Kin on file yet", kinShowEmptyText("", KinShow.All, anyOnFile = false).first)
        assertEquals("No matches for \"zz\"", kinShowEmptyText("zz", KinShow.Archived, anyOnFile = true).first)
    }

    // ── #1958 ────────────────────────────────────────────────────────────────

    @Test
    fun aRestoreCarriesTheStatusTheServerGaveBack() = runBlocking {
        JvmFirestoreFixtures.callableResponses =
            mapOf("setKinfolkArchived" to """{"ok":true,"archived":false,"status":"prospect","changed":true}""")
        assertEquals(WriteResult.Ok("prospect"), FirestoreClient().restoreKinfolk("kf1"))
    }

    @Test
    fun theRestoreAnswerReadsSafely() {
        assertEquals("prospect", restoredKinfolkStatusFrom("""{"status":"prospect"}"""))
        assertEquals("inactive", restoredKinfolkStatusFrom("""{"status":" Inactive "}"""))
        assertEquals("active", restoredKinfolkStatusFrom("""{"ok":true}"""))
        assertEquals("active", restoredKinfolkStatusFrom("""{"status":"archived"}"""))
        assertEquals("active", restoredKinfolkStatusFrom("not json"))
    }

    @Test
    fun theRestoreToastNamesTheStatus() {
        assertEquals("Dana Mercer is restored as a Prospect.", kinfolkRestoredMessage("Dana Mercer", "prospect"))
        assertEquals("Dana Mercer is restored as Inactive.", kinfolkRestoredMessage("Dana Mercer", "inactive"))
        assertEquals("Dana Mercer is active again.", kinfolkRestoredMessage("Dana Mercer", "active"))
    }

    // ── #1951 ────────────────────────────────────────────────────────────────

    @Test
    fun eachContactFieldSaysWhatIsWrong() {
        assertEquals(KINFOLK_PHONE_INVALID, kinfolkPhoneMessage("abc"))
        assertEquals(KINFOLK_PHONE_INVALID, kinfolkPhoneMessage("555-0134"))
        assertEquals(KINFOLK_PHONE_REQUIRED, kinfolkPhoneMessage(""))
        assertNull(kinfolkPhoneMessage("(805) 555-0134"))
        assertEquals(KINFOLK_EMAIL_INVALID, kinfolkEmailMessage("catch"))
        assertEquals(KINFOLK_EMAIL_INVALID, kinfolkEmailMessage("catch@hanasamku"))
        assertEquals(KINFOLK_EMAIL_REQUIRED, kinfolkEmailMessage(" "))
        assertNull(kinfolkEmailMessage("catch@hanasamku.com"))
        assertEquals(KINFOLK_SECONDARY_PHONE_INVALID, kinfolkSecondaryPhoneMessage("xyz"))
        assertNull(kinfolkSecondaryPhoneMessage(""))
        assertEquals(KINFOLK_EMAIL_INVALID, kinfolkSecondaryEmailMessage("pawsome"))
        assertNull(kinfolkSecondaryEmailMessage("pawsome@hanasamku.com"))
    }

    @Test
    fun anEmergencyContactPhoneOfLettersIsCaughtBeforeTheCreate() {
        assertEquals(EMERGENCY_CONTACT_PHONE_SHAPE, emergencyContactPhoneShapeError(listOf(EmergencyContactDraft("Rae Park", "xyz"))))
        assertNull(emergencyContactPhoneShapeError(listOf(EmergencyContactDraft("Rae Park", "8055550199"))))
        assertNull(emergencyContactPhoneShapeError(listOf(EmergencyContactDraft("Rae Park", ""))))
    }

    // ── #2115 ────────────────────────────────────────────────────────────────

    @Test
    fun aKinSaveNeverWritesTheLinkToTheHouseholdCopy() {
        // A Kin the household added in the portal: its household copy id differs
        // from the admin record id. The editor builds from the loaded record, so
        // the link rides along unchanged and the diff never names it.
        val loaded = Kin(_id = "admin-k1", kinfolkId = "kf1", name = "Willow", familyKinPath = "families/kf1/kin/portal-7")
        val edited = loaded.copy(sex = "Female", weight = "40")
        val paths = kinChanges(loaded, edited).map { it.path.first() }
        assertTrue("familyKinPath" !in paths, "the save names the link: $paths")
        assertTrue("kinfolkId" !in paths)
        assertEquals(setOf("sex", "weight"), paths.toSet())
    }
}
