package com.kinfolk.portal.screens.tribe
import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.portal.CustomField
import com.kinfolk.portal.portal.HomeAccess
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.portal.TribeProfile
import com.kinfolk.portal.portal.TribeProfileResult
import com.kinfolk.portal.portal.VetClinicSummary
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
/** #1325: the Vet line on the Tribe page, and the clinic the server resolves, never the database id. */
class VetFactTest {
    private fun profile(fields: List<CustomField>, vet: VetClinicSummary? = null) = TribeProfileResult(
        profile = TribeProfile("3", "X", fields),
        homeAccess = HomeAccess(null, null, null, emptyList(), null),
        vetClinic = vet,
    )
    @Test
    fun aPickedClinicShowsByNameAddressAndFormattedPhone() {
        val p = profile(
            listOf(CustomField("vetClinicId", "Vet Clinic", "m5rTfebiqMxckecn4OCM")),
            VetClinicSummary("m5rTfebiqMxckecn4OCM", "Banfield Pet Hospital", "+18055550123", "1 Main St"),
        )
        val line = vetFact(p)
        assertEquals("Vet: Banfield Pet Hospital \u00b7 1 Main St \u00b7 (805) 555-0123", line)
        assertFalse(line!!.contains("m5rTf"))
    }
    @Test
    fun theOldNameRowIsOnlyTheFallback() {
        val legacy = listOf(CustomField("vetClinicName", "Vet", "Old Town Vet"))
        assertEquals("Vet: Old Town Vet", vetFact(profile(legacy)))
        val both = profile(legacy, VetClinicSummary("c", "Picked Vet", "", ""))
        assertEquals("Vet: Picked Vet", vetFact(both))
    }
    @Test
    fun aBareIdShowsNothing() {
        assertNull(vetFact(profile(listOf(CustomField("vetClinicId", "Vet Clinic", "m5rTfebiqMxckecn4OCM")))))
    }
    @Test
    fun theIdRowIsOwnedByTheVetCard_soItIsNeverListedAsAnAuntieField() {
        assertTrue("vetClinicId" in SCREEN_OWNED_CUSTOM_FIELD_KEYS)
        val shown = visibleCustomFields(listOf(CustomField("vetClinicId", "Vet Clinic", "abc"), CustomField("k1", "Anniversary", "Oct 14")))
        assertEquals(listOf("k1"), shown.map { it.key })
    }
    @Test
    fun getMyTribeProfile_readsTheResolvedClinic_andNullWhenNoneOrOlderBackend() = runTest {
        val base = buildJsonObject {
            put("profile", buildJsonObject {
                put("kinfolkId", "3"); put("displayName", "X"); put("customFields", buildJsonArray {})
            })
            put("homeAccess", buildJsonObject {
                put("gateCode", JsonNull); put("keyLocation", JsonNull); put("wifiPassword", JsonNull)
                put("customFields", buildJsonArray {}); put("updatedAtMs", JsonNull)
            })
        }
        val fake = FakeFunctionsClient()
        fake.stub("getMyTribeProfile", buildJsonObject {
            base.forEach { (k, v) -> put(k, v) }
            put("vetClinic", buildJsonObject {
                put("id", "c1"); put("name", "ER Vet"); put("phone", "+18055550123"); put("address", "1 St"); put("isEmergency", true)
            })
        })
        val got = PortalApi(fake).getMyTribeProfile("3").vetClinic
        assertEquals(VetClinicSummary("c1", "ER Vet", "+18055550123", "1 St", true), got)
        fake.stub("getMyTribeProfile", buildJsonObject { base.forEach { (k, v) -> put(k, v) }; put("vetClinic", JsonNull) })
        assertNull(PortalApi(fake).getMyTribeProfile("3").vetClinic)
        fake.stub("getMyTribeProfile", base)
        assertNull(PortalApi(fake).getMyTribeProfile("3").vetClinic)
    }
}
