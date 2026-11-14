package com.kinfolk.portal.portal

import com.kinfolk.portal.components.RoutePoint
import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.firebase.FirestoreClient
import com.kinfolk.portal.firebase.FirestoreDoc
import com.kinfolk.portal.screens.kin.KIN_MEDICATIONS_MAX
import com.kinfolk.portal.screens.kin.careFactsPayload
import com.kinfolk.portal.screens.kin.kinCareFacts
import com.kinfolk.portal.screens.kin.kinVetLine
import com.kinfolk.portal.screens.kin.medicationsProblem
import com.kinfolk.portal.screens.tribe.CustomFieldEdit
import com.kinfolk.portal.screens.tribe.VET_CLINIC_ID_KEY
import com.kinfolk.portal.screens.tribe.householdVetSaveFailure
import com.kinfolk.portal.screens.tribe.profileSaveEdit
import com.kinfolk.portal.screens.tribe.vetClinicChoices
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #1908 (owner ruling 2026-11-11): the care facts the admin always kept are the
 * household's to fill too. #1908 kin-vet (2026-11-12): a Kin goes to the
 * household's vet unless "Different vet for this Kin" is ticked. #1917: the
 * household vet is saved the moment it is picked.
 */
class KinCareFactsAndVetTest {

    private fun kin(
        staysAs: String? = null,
        routine: String? = null,
        trainingCommands: String? = null,
        feedingBrand: String? = null,
        vaccinations: String? = null,
        ownVetClinicId: String = "",
        vetInfo: String? = null,
        vet: KinVet? = null,
        medications: String? = null,
    ) = Kin(
        id = "k1", name = "Buddy", species = "Dog", breed = null, ageYears = null, photoUrl = null,
        status = KinStatus.Active, feedingInstructions = null, walkingInstructions = null,
        medications = medications, allergies = null, emergencyNotes = null, sitterNotes = null,
        vetInfo = vetInfo, staysAs = staysAs, routine = routine, trainingCommands = trainingCommands,
        feedingBrand = feedingBrand, vaccinations = vaccinations, ownVetClinicId = ownVetClinicId, vet = vet,
    )

    private val cedar = VetClinicSummary("home", "Cedar Animal Care", "8055550142", "1 Main St")
    private val catalog = listOf(
        VetClinic("home", "Cedar Animal Care", "8055550142", "1 Main St"),
        VetClinic("own", "Riverside Vets", "8055550199", "2 River Rd"),
        VetClinic("a1", "Arbor Pet Clinic", "", ""),
    )

    // ---- decode ----

    @Test
    fun `getMyKin reads the care facts, the Kin vet and the resolved vet, and defaults them when absent`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyKin", buildJsonObject {
            put("kin", buildJsonArray {
                add(buildJsonObject {
                    put("id", "k1"); put("status", "active")
                    put("staysAs", "Crate at night"); put("routine", "Walk at 7"); put("trainingCommands", "Sit")
                    put("feedingBrand", "Acme"); put("vaccinations", "Rabies 2027"); put("ownVetClinicId", "own")
                    put("vet", buildJsonObject {
                        put("clinic", buildJsonObject {
                            put("id", "own"); put("name", "Riverside Vets"); put("phone", "8055550199")
                            put("address", "2 River Rd"); put("isEmergency", false)
                        })
                        put("fromHousehold", false)
                    })
                })
                add(buildJsonObject {
                    put("id", "k2"); put("status", "active")
                    put("staysAs", JsonNull); put("vet", JsonNull)
                })
            })
        })
        val res = PortalApi(fake).getMyKin().kin
        assertEquals("Crate at night", res[0].staysAs)
        assertEquals("Walk at 7", res[0].routine)
        assertEquals("Sit", res[0].trainingCommands)
        assertEquals("Acme", res[0].feedingBrand)
        assertEquals("Rabies 2027", res[0].vaccinations)
        assertEquals("own", res[0].ownVetClinicId)
        assertEquals(KinVet(VetClinicSummary("own", "Riverside Vets", "8055550199", "2 River Rd"), fromHousehold = false), res[0].vet)
        assertNull(res[1].staysAs)
        assertNull(res[1].routine)
        assertEquals("", res[1].ownVetClinicId)
        assertNull(res[1].vet)
    }

    private class OneDocFirestore(private val fields: Map<String, Any?>) : FirestoreClient {
        override suspend fun getDocument(collection: String, documentId: String): Map<String, Any?>? = null
        override suspend fun listDocuments(collection: String): List<FirestoreDoc> = listOf(FirestoreDoc("k1", fields))
        override fun breadcrumbsStream(sessionId: String): Flow<List<RoutePoint>> = flowOf(emptyList())
    }

    @Test
    fun `a direct read decodes the care facts and the Kin vet, null and absent included`() = runTest {
        val fs = OneDocFirestore(mapOf(
            "name" to "Biscuit", "status" to "active", "staysAs" to "Crate", "routine" to null,
            "vaccinations" to "", "ownVetClinicId" to " own ",
        ))
        val k = PortalApi(FakeFunctionsClient(), fs).getMyKin("fam1").kin.single()
        assertEquals("Crate", k.staysAs)
        assertNull(k.routine)
        assertNull(k.trainingCommands)
        assertNull(k.vaccinations)
        assertEquals("own", k.ownVetClinicId)
        assertNull(k.vet, "a direct read cannot see the household vet store")
    }

    // ---- write ----

    @Test
    fun `updateKin sends the care facts and the Kin vet it was given, and omits the rest`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("updateKin", buildJsonObject { put("ok", true) })
        PortalApi(fake).updateKin(
            kinId = "k1",
            kin = KinPayload(name = "Buddy", staysAs = "Crate", routine = "", ownVetClinicId = ""),
        )
        val sent = fake.calls.single().second!!["kin"]!!.jsonObject
        assertEquals("Crate", sent["staysAs"]!!.jsonPrimitive.content)
        assertEquals("", sent["routine"]!!.jsonPrimitive.content)
        assertEquals("", sent["ownVetClinicId"]!!.jsonPrimitive.content)
        for (k in listOf("trainingCommands", "feedingBrand", "vaccinations", "vetInfo")) assertFalse(sent.containsKey(k), k)
    }

    @Test
    fun `an unchanged form sends no care fact and no Kin vet`() {
        val k = kin(staysAs = "Crate", routine = "Walk", trainingCommands = "Sit", feedingBrand = "Acme", vaccinations = "Rabies", ownVetClinicId = "own")
        val c = careFactsPayload(k, "Crate", "Walk", "Sit", "Acme", "Rabies", ownVetTicked = true, ownVetId = "own")
        assertEquals(CareFactsNone, listOf(c.staysAs, c.routine, c.trainingCommands, c.feedingBrand, c.vaccinations, c.ownVetClinicId))
    }

    private val CareFactsNone = listOf<String?>(null, null, null, null, null, null)

    @Test
    fun `each care fact is sent when changed, and as empty when emptied`() {
        val k = kin(staysAs = "Crate", routine = "Walk")
        val c = careFactsPayload(k, " Crate ", "", "Sit", "Acme", "Rabies 2027", ownVetTicked = false, ownVetId = "")
        assertNull(c.staysAs)
        assertEquals("", c.routine)
        assertEquals("Sit", c.trainingCommands)
        assertEquals("Acme", c.feedingBrand)
        assertEquals("Rabies 2027", c.vaccinations)
        assertNull(c.ownVetClinicId)
    }

    @Test
    fun `adding a kin sends only the care facts filled in`() {
        val c = careFactsPayload(null, "", "Walk", "", "", "", ownVetTicked = false, ownVetId = "")
        assertNull(c.staysAs)
        assertEquals("Walk", c.routine)
        assertNull(c.ownVetClinicId)
    }

    // ---- Kin vet: inheritance ----

    @Test
    fun `ticking the box and picking a clinic sends that clinic`() {
        assertEquals("own", careFactsPayload(kin(), "", "", "", "", "", ownVetTicked = true, ownVetId = "own").ownVetClinicId)
    }

    @Test
    fun `unticking the box sends empty, back to the household vet`() {
        val k = kin(ownVetClinicId = "own")
        assertEquals("", careFactsPayload(k, "", "", "", "", "", ownVetTicked = false, ownVetId = "own").ownVetClinicId)
    }

    @Test
    fun `ticked with nothing picked is the household vet, so an inheriting Kin sends nothing`() {
        assertNull(careFactsPayload(kin(), "", "", "", "", "", ownVetTicked = true, ownVetId = "").ownVetClinicId)
    }

    @Test
    fun `a Kin with no vet of its own goes to the household vet`() {
        assertEquals(KinVet(cedar, fromHousehold = true), resolveKinVet(kin(), cedar, catalog))
    }

    @Test
    fun `a Kin with its own vet goes to that one, not the household vet`() {
        val v = resolveKinVet(kin(ownVetClinicId = "own"), cedar, catalog)
        assertEquals("Riverside Vets", v?.clinic?.name)
        assertEquals(false, v?.fromHousehold)
    }

    @Test
    fun `an own vet that is no longer on the list is no vet, never the household one`() {
        assertNull(resolveKinVet(kin(ownVetClinicId = "gone"), cedar, catalog))
    }

    @Test
    fun `no household vet and none of its own is no vet`() {
        assertNull(resolveKinVet(kin(), null, catalog))
    }

    @Test
    fun `the server's resolved vet wins over the client lookup`() {
        val server = KinVet(VetClinicSummary("x", "Server Vet", "", ""), fromHousehold = false)
        assertEquals(server, resolveKinVet(kin(ownVetClinicId = "own", vet = server), cedar, catalog))
    }

    // ---- detail rows ----

    @Test
    fun `the Care card shows the care facts and the vet, saying when it is the household's`() {
        val rows = kinCareFacts(kin(staysAs = "Crate", vaccinations = "Rabies", medications = "Thyroid", vetInfo = "Old note"), KinVet(cedar, true)).toMap()
        assertEquals("Crate", rows["STAYS AS"])
        assertEquals("Rabies", rows["VACCINATIONS"])
        assertEquals("Thyroid", rows["MEDICATIONS / HEALTH NOTES"])
        assertTrue(rows["VET"]!!.startsWith("Cedar Animal Care"))
        assertTrue(rows["VET"]!!.endsWith("from your Tribe Profile"))
        assertNull(rows["VET NOTES"], "the old note shows only when no clinic resolves")
    }

    @Test
    fun `the old free-text vet note shows, labelled, only when no clinic resolves`() {
        val rows = kinCareFacts(kin(vetInfo = "Dr A, 555 0100"), null).toMap()
        assertEquals("Dr A, 555 0100", rows["VET NOTES"])
        assertNull(rows["VET"])
    }

    @Test
    fun `a Kin vet of its own reads without the Tribe Profile note`() {
        assertFalse(kinVetLine(KinVet(cedar, fromHousehold = false)).contains("Tribe Profile"))
    }

    // ---- medications ----

    @Test
    fun `Medications takes up to the server's 4000 characters`() {
        assertNull(medicationsProblem("m".repeat(KIN_MEDICATIONS_MAX)))
        assertNotNull(medicationsProblem("m".repeat(KIN_MEDICATIONS_MAX + 1)))
    }

    // ---- the area vet list ----

    @Test
    fun `the vet dropdown lists every clinic when nothing is typed, sorted, and narrows by name`() {
        val many = (1..20).map { VetClinic("c$it", "Clinic $it", "", "") }
        assertEquals(20, vetClinicChoices("", many).size, "no cap of 8: the whole area list")
        assertEquals(listOf("Arbor Pet Clinic", "Cedar Animal Care", "Riverside Vets"), vetClinicChoices("", catalog).map { it.name })
        assertEquals(listOf("Riverside Vets"), vetClinicChoices("river", catalog).map { it.name })
    }

    // ---- #1917: the household vet ----

    @Test
    fun `setHouseholdVet sends the picked clinic and reads back the vet on file`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("setHouseholdVet", buildJsonObject {
            put("ok", true)
            put("vetClinic", buildJsonObject { put("id", "home"); put("name", "Cedar Animal Care"); put("phone", "8055550142"); put("address", "1 Main St") })
        })
        val now = PortalApi(fake).setHouseholdVet(kinfolkId = "3", clinicId = " home ")
        val sent = fake.calls.single()
        assertEquals("setHouseholdVet", sent.first)
        assertEquals("3", sent.second!!["kinfolkId"]!!.jsonPrimitive.content)
        assertEquals("home", sent.second!!["clinicId"]!!.jsonPrimitive.content)
        assertEquals(cedar, now)
    }

    @Test
    fun `removing the household vet sends empty and reads back none`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("setHouseholdVet", buildJsonObject { put("ok", true); put("vetClinic", JsonNull) })
        assertNull(PortalApi(fake).setHouseholdVet(clinicId = ""))
        assertEquals("", fake.calls.single().second!!["clinicId"]!!.jsonPrimitive.content)
    }

    @Test
    fun `the page Save neither sends nor removes the vet clinic row`() {
        val stored = listOf(
            CustomField(key = "allergy", label = "Allergies", value = "Chicken"),
            CustomField(key = VET_CLINIC_ID_KEY, label = "Vet Clinic", value = "old"),
        )
        val edit: CustomFieldEdit = profileSaveEdit(
            stored,
            set = listOf(CustomField(key = VET_CLINIC_ID_KEY, label = "Vet Clinic", value = "stale")),
            clear = listOf(VET_CLINIC_ID_KEY),
        )
        assertEquals(listOf("allergy"), edit.customFields.map { it.key })
        assertEquals(emptyList(), edit.removeKeys)
    }

    @Test
    fun `a pick that did not save says so`() {
        assertEquals("This clinic was not saved: That vet is not on the list.", householdVetSaveFailure(true, "That vet is not on the list."))
        assertEquals("The clinic was not removed: try again.", householdVetSaveFailure(false, null))
    }
}
