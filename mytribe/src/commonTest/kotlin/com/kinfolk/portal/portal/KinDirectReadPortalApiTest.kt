package com.kinfolk.portal.portal

import com.kinfolk.portal.components.RoutePoint
import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.firebase.FirestoreClient
import com.kinfolk.portal.firebase.FirestoreDoc
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #1282: `PortalApi.getMyKin` reads `families/{id}/kin` first and keeps the
 * `getMyKin` callable (the cold start this issue is about) as its fallback.
 * The mapping cases mirror functions/src/portal/getMyKin.ts.
 */
class KinDirectReadPortalApiTest {

    private class ScriptedFirestore(
        private val docs: List<FirestoreDoc> = emptyList(),
        private val failure: Throwable? = null,
    ) : FirestoreClient {
        val listed = mutableListOf<String>()
        override suspend fun getDocument(collection: String, documentId: String): Map<String, Any?>? = null
        override suspend fun listDocuments(collection: String): List<FirestoreDoc> {
            listed += collection
            failure?.let { throw it }
            return docs
        }
        override fun breadcrumbsStream(sessionId: String): Flow<List<RoutePoint>> = flowOf(emptyList())
    }

    private val callableRoster = buildJsonObject {
        put("kin", buildJsonArray { add(buildJsonObject { put("id", "from-callable"); put("status", "active") }) })
    }

    @Test
    fun `a known household is answered from Firestore and never calls the callable`() = runTest {
        val fns = FakeFunctionsClient()
        val fs = ScriptedFirestore(listOf(FirestoreDoc("k1", mapOf("name" to "Biscuit", "status" to "active"))))
        val result = PortalApi(fns, fs).getMyKin("fam1")
        assertEquals(listOf("families/fam1/kin"), fs.listed)
        assertEquals(listOf("k1"), result.kin.map { it.id })
        assertTrue(fns.calls.isEmpty(), "getMyKin callable should not be called, got ${fns.calls}")
    }

    @Test
    fun `a refused direct read falls back to the callable`() = runTest {
        val fns = FakeFunctionsClient().apply { stub("getMyKin", callableRoster) }
        val fs = ScriptedFirestore(failure = IllegalStateException("PERMISSION_DENIED"))
        val result = PortalApi(fns, fs).getMyKin("fam1")
        assertEquals(listOf("from-callable"), result.kin.map { it.id })
        assertEquals("getMyKin", fns.calls.single().first)
    }

    @Test
    fun `no household id lets the callable pick the default tribe`() = runTest {
        val fns = FakeFunctionsClient().apply { stub("getMyKin", callableRoster) }
        val fs = ScriptedFirestore()
        PortalApi(fns, fs).getMyKin(null)
        assertTrue(fs.listed.isEmpty())
        assertEquals("getMyKin", fns.calls.single().first)
    }

    @Test
    fun `without a Firestore client the callable path is unchanged`() = runTest {
        val fns = FakeFunctionsClient().apply { stub("getMyKin", callableRoster) }
        PortalApi(fns).getMyKin("fam1")
        assertEquals("getMyKin", fns.calls.single().first)
    }

    @Test
    fun `mapping copies the portal fields and nulls missing or empty ones`() {
        val kin = kinFromDocument(
            "k1",
            mapOf(
                "name" to "Biscuit", "species" to "Dog", "breed" to "", "ageYears" to 4L,
                "photoUrl" to "https://res.cloudinary.com/x.jpg", "allergies" to "Chicken",
                "legacyKinId" to "L-9", "sex" to "Male", "spayedNeutered" to true, "vetInfo" to "",
            ),
        )!!
        assertEquals("Biscuit", kin.name)
        assertEquals("Dog", kin.species)
        assertNull(kin.breed)
        assertEquals(4.0, kin.ageYears)
        assertEquals("Chicken", kin.allergies)
        assertNull(kin.medications)
        assertEquals(KinStatus.Active, kin.status)
        assertEquals("Male", kin.sex)
        assertEquals(true, kin.spayedNeutered)
        assertNull(kin.vetInfo)
        assertEquals(false, kinFromDocument("k", mapOf("spayedNeutered" to "yes"))!!.spayedNeutered)
    }

    @Test
    fun `age follows the server's parseFloat rule`() {
        assertEquals(3.5, kinFromDocument("k", mapOf("ageYears" to "3.5"))!!.ageYears)
        assertEquals(4.0, kinFromDocument("k", mapOf("ageYears" to "4 years"))!!.ageYears)
        assertNull(kinFromDocument("k", mapOf("ageYears" to "old"))!!.ageYears)
    }

    @Test
    fun `statuses - memorial kept, legacy admin ones hidden, anything else active`() {
        assertEquals(KinStatus.NoLongerWithUs, kinFromDocument("k", mapOf("status" to "noLongerWithUs"))!!.status)
        assertEquals(KinStatus.Active, kinFromDocument("k", emptyMap())!!.status)
        assertEquals(KinStatus.Active, kinFromDocument("k", mapOf("status" to "brand-new"))!!.status)
        assertNull(kinFromDocument("k", mapOf("status" to "inactive")))
        assertNull(kinFromDocument("k", mapOf("status" to "archived")))
    }
}
