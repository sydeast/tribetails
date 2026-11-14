package com.tribetails.auntieos.web.data

import com.tribetails.auntieos.web.screens.directory.DIFFERENT_VET_LABEL
import com.tribetails.auntieos.web.screens.directory.HouseholdVetSlot
import com.tribetails.auntieos.web.screens.directory.filterVetClinics
import com.tribetails.auntieos.web.screens.directory.householdVetOptions
import com.tribetails.auntieos.web.screens.directory.legacyHouseholdVetLines
import com.tribetails.auntieos.web.screens.directory.withHouseholdVet
import com.tribetails.auntieos.web.screens.directory.NO_HOUSEHOLD_VET
import com.tribetails.auntieos.web.screens.directory.differentVetIsComplete
import com.tribetails.auntieos.web.screens.directory.householdVetText
import com.tribetails.auntieos.web.screens.directory.ownVetClinicIdForSave
import com.tribetails.auntieos.web.screens.directory.pickableVetClinics
import com.tribetails.auntieos.web.screens.directory.resolveKinVet
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #1907, #1908 on the desktop console: the Kin fields both apps now share.
 *
 *  - the care block the household keeps (feeding, walking, allergies,
 *    emergency notes, notes for the Auntie) is on the desktop `Kin` model, so
 *    Edit kin has a box for each and a save writes exactly the one changed;
 *  - every shared text field reads an explicit null as "" (#1370): the desktop
 *    codec does not coerce, and a null used to drop the whole Kin from the list;
 *  - the Kin vet (#1908 kin-vet) is the household's unless the Kin has its own.
 *
 * [MaskApplyingFirestore] applies each PATCH the way Firestore does.
 */
class DesktopKinSharedFieldsTest {

    private val fs = MaskApplyingFirestore()
    private val docs get() = fs.docs
    private val masks get() = fs.masks
    private fun str(s: String) = MaskApplyingFirestore.str(s)
    private val nul: JsonObject = buildJsonObject { put("nullValue", "NULL_VALUE") }

    @BeforeTest
    fun setUp() = fs.start()

    @AfterTest
    fun tearDown() = fs.stop()

    private val stored get() = docs.getValue("kin/k1")

    // ── null decode (#1370) ─────────────────────────────────────────────────

    @Test
    fun everySharedTextFieldReadsANullAsEmptyAndTheKinIsKept() = runBlocking<Unit> {
        val nullable = listOf(
            "age", "sex", "weight", "breed", "colorMarkings", "staysAs", "routine", "trainingCommands",
            "feedingBrand", "vaccinations", "medicationHealthNotes", "vetInfo", "feedingInstructions",
            "walkingInstructions", "allergies", "emergencyNotes", "sitterNotes", "ownVetClinicId",
        )
        docs["kin/k1"] = buildJsonObject {
            put("kinfolkId", str("kf1"))
            put("name", str("Biscuit"))
            for (f in nullable) put(f, nul)
        }
        val kin = JvmFirestoreRest.getDoc<Kin>("kin", "k1")
        assertNotNull(kin, "a null text field must not drop the Kin")
        assertEquals("Biscuit", kin.name)
        for (value in listOf(
            kin.age, kin.sex, kin.weight, kin.breed, kin.colorMarkings, kin.staysAs, kin.routine,
            kin.trainingCommands, kin.feedingBrand, kin.vaccinations, kin.medicationHealthNotes, kin.vetInfo,
            kin.feedingInstructions, kin.walkingInstructions, kin.allergies, kin.emergencyNotes,
            kin.sitterNotes, kin.ownVetClinicId,
        )) assertEquals("", value)
    }

    @Test
    fun theNewFieldsDecodeWhenSet() = runBlocking<Unit> {
        docs["kin/k1"] = buildJsonObject {
            put("name", str("Biscuit"))
            put("feedingInstructions", str("1 cup AM"))
            put("walkingInstructions", str("Short loop"))
            put("allergies", str("Chicken"))
            put("emergencyNotes", str("Call the vet first"))
            put("sitterNotes", str("Leash by the door"))
            put("ownVetClinicId", str("clinic-2"))
        }
        val kin = JvmFirestoreRest.getDoc<Kin>("kin", "k1")!!
        assertEquals("1 cup AM", kin.feedingInstructions)
        assertEquals("Short loop", kin.walkingInstructions)
        assertEquals("Chicken", kin.allergies)
        assertEquals("Call the vet first", kin.emergencyNotes)
        assertEquals("Leash by the door", kin.sitterNotes)
        assertEquals("clinic-2", kin.ownVetClinicId)
    }

    // ── one box per field: a save writes the one it changed ─────────────────

    private fun seed() {
        docs["kin/k1"] = buildJsonObject {
            put("kinfolkId", str("kf1"))
            put("name", str("Biscuit"))
            put("feedingInstructions", str("1 cup AM"))
            put("allergies", nul)
            put("officeNotes", str("staff only"))
        }
    }

    private suspend fun saveOne(edit: (Kin) -> Kin): Kin {
        val loaded = JvmFirestoreRest.getDoc<Kin>("kin", "k1")!!
        assertEquals(WriteResult.Ok(true), FirestoreClient().updateKin(loaded, edit(loaded)))
        return loaded
    }

    @Test
    fun feedingInstructionsSavesAlone() = runBlocking<Unit> {
        seed(); saveOne { it.copy(feedingInstructions = "2 cups AM") }
        assertEquals(listOf<List<String>?>(listOf("feedingInstructions")), masks)
        assertEquals(str("2 cups AM"), stored["feedingInstructions"])
        assertEquals(str("staff only"), stored["officeNotes"])
    }

    @Test
    fun walkingInstructionsSavesAlone() = runBlocking<Unit> {
        seed(); saveOne { it.copy(walkingInstructions = "Cedar St loop") }
        assertEquals(listOf<List<String>?>(listOf("walkingInstructions")), masks)
        assertEquals(str("Cedar St loop"), stored["walkingInstructions"])
    }

    @Test
    fun allergiesSavesAloneOverAStoredNull() = runBlocking<Unit> {
        seed(); saveOne { it.copy(allergies = "Chicken") }
        assertEquals(listOf<List<String>?>(listOf("allergies")), masks)
        assertEquals(str("Chicken"), stored["allergies"])
    }

    @Test
    fun emergencyNotesSavesAlone() = runBlocking<Unit> {
        seed(); saveOne { it.copy(emergencyNotes = "Call the vet first") }
        assertEquals(listOf<List<String>?>(listOf("emergencyNotes")), masks)
    }

    @Test
    fun notesForTheAuntieSaveAsSitterNotesAndLeaveTheOfficeNotesAlone() = runBlocking<Unit> {
        seed(); saveOne { it.copy(sitterNotes = "Leash by the door") }
        assertEquals(listOf<List<String>?>(listOf("sitterNotes")), masks)
        assertEquals(str("staff only"), stored["officeNotes"])
    }

    @Test
    fun aKinVetOfItsOwnSavesAloneAndUntickingClearsIt() = runBlocking<Unit> {
        seed(); saveOne { it.copy(ownVetClinicId = "clinic-2") }
        assertEquals(str("clinic-2"), stored["ownVetClinicId"])
        masks.clear()
        saveOne { it.copy(ownVetClinicId = ownVetClinicIdForSave(differentVet = false, pickedClinicId = "clinic-2")) }
        assertEquals(listOf<List<String>?>(listOf("ownVetClinicId")), masks)
        assertEquals(str(""), stored["ownVetClinicId"])
    }

    @Test
    fun aStoredNullUntouchedIsNotRewritten() = runBlocking<Unit> {
        seed()
        val loaded = JvmFirestoreRest.getDoc<Kin>("kin", "k1")!!
        assertEquals(WriteResult.Ok(false), FirestoreClient().updateKin(loaded, loaded.copy()))
        assertEquals(emptyList<List<String>?>(), masks)
        assertEquals(nul, stored["allergies"])
    }

    @Test
    fun kinChangesNamesEachNewKey() {
        val base = Kin(_id = "k1")
        val edited = base.copy(
            feedingInstructions = "a", walkingInstructions = "b", allergies = "c",
            emergencyNotes = "d", sitterNotes = "e", ownVetClinicId = "f",
        )
        assertEquals(
            setOf("feedingInstructions", "walkingInstructions", "allergies", "emergencyNotes", "sitterNotes", "ownVetClinicId"),
            kinChanges(base, edited).map { it.path.single() }.toSet(),
        )
    }

    // ── #1908 kin-vet ───────────────────────────────────────────────────────

    private val home = VetClinic(_id = "home", name = "Cedar Animal Care", phone = "555 0142", address = "1 Main St")
    private val own = VetClinic(_id = "own", name = "Riverside Vets", phone = "555 0199")
    private val retired = VetClinic(_id = "old", name = "Old Clinic", archived = true)
    private val pending = VetClinic(_id = "new", name = "New Clinic", verified = false)
    private val clinics = listOf(own, home, retired, pending)

    @Test
    fun aKinWithNoVetOfItsOwnGoesToTheHouseholdVet() {
        val line = resolveKinVet(Kin(), "home", clinics)
        assertEquals(home, line.clinic)
        assertTrue(line.fromHousehold)
    }

    @Test
    fun aKinWithItsOwnVetGoesToThatOne() {
        val line = resolveKinVet(Kin(ownVetClinicId = "own"), "home", clinics)
        assertEquals(own, line.clinic)
        assertFalse(line.fromHousehold)
    }

    @Test
    fun aKinVetThatNoLongerExistsShowsNoClinicRatherThanTheHouseholdOne() {
        val line = resolveKinVet(Kin(ownVetClinicId = "gone", vetInfo = "Dr A"), "home", clinics)
        assertNull(line.clinic)
        assertEquals("Dr A", line.legacyNote)
    }

    @Test
    fun theOldFreeTextNoteShowsOnlyWhenNoClinicResolves() {
        assertEquals("", resolveKinVet(Kin(vetInfo = "Dr A"), "home", clinics).legacyNote)
        assertEquals("Dr A", resolveKinVet(Kin(vetInfo = "Dr A"), "", clinics).legacyNote)
    }

    @Test
    fun theDropdownOffersTheWholeAreaListButRetiredAndPendingClinics() {
        assertEquals(listOf("home", "own"), pickableVetClinics(clinics).map { it._id })
    }

    @Test
    fun theBoxSavesThePickWhenTickedAndTheHouseholdVetWhenNot() {
        assertEquals("own", ownVetClinicIdForSave(true, "own"))
        assertEquals("", ownVetClinicIdForSave(false, "own"))
        assertFalse(differentVetIsComplete(true, ""), "a ticked box needs a vet picked")
        assertTrue(differentVetIsComplete(false, ""))
        assertEquals("Different vet for this Kin", DIFFERENT_VET_LABEL)
    }

    @Test
    fun theHouseholdVetLineNamesTheClinicOrSaysThereIsNone() {
        assertEquals("Cedar Animal Care · 555 0142 · 1 Main St", householdVetText("home", clinics))
        assertEquals(NO_HOUSEHOLD_VET, householdVetText("", clinics))
        assertEquals(NO_HOUSEHOLD_VET, householdVetText("gone", clinics))
    }

    @Test
    fun theHouseholdDataModelCarriesTheVetLinkAndASaveLeavesItAlone() {
        val hd = HouseholdData(kinfolkId = "kf1", primaryVetClinicId = "home")
        assertTrue(modelChanges(HouseholdData.serializer(), hd, hd.copy(foodLocation = "Pantry")).none { it.path.first() == "primaryVetClinicId" })
    }

    // ── #1908 kin-vet: the household vet dropdown on Household Data ─────────
    @Test
    fun thePickerListsTheWholeAreaListOnOpenAndNarrowsAsYouType() {
        val area = pickableVetClinics(clinics)
        assertEquals(area, filterVetClinics(area, ""), "a blank search lists them all")
        assertEquals(listOf("own"), filterVetClinics(area, "river").map { it._id })
        assertEquals(listOf("home"), filterVetClinics(area, "MAIN ST").map { it._id }, "the address matches too")
        assertEquals(emptyList(), filterVetClinics(area, "zzz"))
    }
    @Test
    fun theEmergencyVetDropdownOffersOnlyEmergencyClinics() {
        val er = VetClinic(_id = "er", name = "Night ER", isEmergency = true)
        val erRetired = VetClinic(_id = "er2", name = "Old ER", isEmergency = true, archived = true)
        assertEquals(listOf("er"), householdVetOptions(clinics + er + erRetired, HouseholdVetSlot.EMERGENCY).map { it._id })
        assertEquals(listOf("home", "er", "own").sorted(), householdVetOptions(clinics + er, HouseholdVetSlot.PRIMARY).map { it._id }.sorted())
    }
    @Test
    fun aPickedHouseholdVetWritesTheLinkAndNothingElse() = runBlocking<Unit> {
        val loaded = HouseholdData(_id = "hd1", kinfolkId = "kf1", primaryVetName = "Dr A", foodLocation = "Pantry")
        docs["household_data/hd1"] = buildJsonObject {
            put("kinfolkId", str("kf1"))
            put("primaryVetName", str("Dr A"))
            put("foodLocation", str("Pantry"))
        }
        val edited = withHouseholdVet(loaded, "kf1", HouseholdVetSlot.PRIMARY, "home")
        assertEquals(WriteResult.Ok(true), FirestoreClient().saveHouseholdData(loaded, edited))
        assertEquals(listOf<List<String>?>(listOf("primaryVetClinicId")), masks)
        val doc = docs.getValue("household_data/hd1")
        assertEquals(str("home"), doc["primaryVetClinicId"])
        assertEquals(str("Dr A"), doc["primaryVetName"], "the legacy text is never touched")
        assertEquals(str("Pantry"), doc["foodLocation"])
    }
    @Test
    fun removingTheHouseholdVetClearsOnlyTheLinkAndTheEmergencySlotIsItsOwn() {
        val loaded = HouseholdData(kinfolkId = "kf1", primaryVetClinicId = "home", emergencyVetClinicId = "er")
        val removed = withHouseholdVet(loaded, "kf1", HouseholdVetSlot.PRIMARY, "")
        assertEquals(listOf(listOf("primaryVetClinicId")), modelChanges(HouseholdData.serializer(), loaded, removed).map { it.path })
        val er = withHouseholdVet(loaded, "kf1", HouseholdVetSlot.EMERGENCY, "er2")
        assertEquals(listOf(listOf("emergencyVetClinicId")), modelChanges(HouseholdData.serializer(), loaded, er).map { it.path })
    }
    @Test
    fun aHouseholdWithNoDocYetGetsOneForThatHousehold() {
        val created = withHouseholdVet(null, "kf1", HouseholdVetSlot.PRIMARY, "home")
        assertEquals("kf1", created.kinfolkId)
        assertEquals("home", created.primaryVetClinicId)
    }
    @Test
    fun theLegacyVetTextShowsReadOnlyOnlyWhileNoClinicIsLinked() {
        val unlinked = HouseholdData(primaryVetName = "Dr A", primaryVetPhone = "555 0100", primaryVetHours = "", emergencyVetName = "Night ER")
        assertEquals(listOf("Name" to "Dr A", "Phone" to "555 0100"), legacyHouseholdVetLines(unlinked, HouseholdVetSlot.PRIMARY))
        assertEquals(listOf("Name" to "Night ER"), legacyHouseholdVetLines(unlinked, HouseholdVetSlot.EMERGENCY))
        assertEquals(emptyList(), legacyHouseholdVetLines(unlinked.copy(primaryVetClinicId = "home"), HouseholdVetSlot.PRIMARY))
        assertEquals(emptyList(), legacyHouseholdVetLines(null, HouseholdVetSlot.PRIMARY))
    }
}
