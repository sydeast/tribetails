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
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
/**
 * #1503: `PortalApi.getVetClinics` reads `vet_clinics` first and keeps the
 * `getVetClinics` callable (the cold start this issue is about) as its
 * fallback. The mapping cases mirror functions/src/portal/getVetClinics.ts.
 */
class VetClinicsDirectReadPortalApiTest {
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
    private val callableCatalog = buildJsonObject {
        put("clinics", buildJsonArray { add(buildJsonObject { put("id", "from-callable"); put("name", "Callable Vet") }) })
    }
    @Test
    fun `answered from Firestore and never calls the callable`() = runTest {
        val fns = FakeFunctionsClient()
        val fs = ScriptedFirestore(listOf(FirestoreDoc("c1", mapOf("name" to "Paws Clinic"))))
        val result = PortalApi(fns, fs).getVetClinics()
        assertEquals(listOf("vet_clinics"), fs.listed)
        assertEquals(listOf("c1"), result.map { it.id })
        assertTrue(fns.calls.isEmpty(), "getVetClinics callable should not be called, got ${fns.calls}")
    }
    @Test
    fun `a refused direct read falls back to the callable`() = runTest {
        val fns = FakeFunctionsClient().apply { stub("getVetClinics", callableCatalog) }
        val fs = ScriptedFirestore(failure = IllegalStateException("PERMISSION_DENIED"))
        val result = PortalApi(fns, fs).getVetClinics()
        assertEquals(listOf("from-callable"), result.map { it.id })
        assertEquals("getVetClinics", fns.calls.single().first)
    }
    @Test
    fun `without a Firestore client the callable path is unchanged`() = runTest {
        val fns = FakeFunctionsClient().apply { stub("getVetClinics", callableCatalog) }
        val result = PortalApi(fns).getVetClinics()
        assertEquals(listOf("from-callable"), result.map { it.id })
        assertEquals("getVetClinics", fns.calls.single().first)
    }
    @Test
    fun `the catalog filter matches the callable - pending, archived and nameless rows are hidden`() = runTest {
        val fs = ScriptedFirestore(
            listOf(
                FirestoreDoc("legacy", mapOf("name" to "Legacy")),
                FirestoreDoc("pending", mapOf("name" to "Pending", "verified" to false)),
                FirestoreDoc("archived", mapOf("name" to "Archived", "archived" to true)),
                FirestoreDoc("nameless", mapOf("name" to "")),
                FirestoreDoc("ok", mapOf("name" to "Ok", "verified" to true, "archived" to false)),
            ),
        )
        assertEquals(listOf("legacy", "ok"), PortalApi(FakeFunctionsClient(), fs).getVetClinics().map { it.id })
    }
    @Test
    fun `mapping copies the portal fields and defaults missing ones`() {
        val full = vetClinicFromDocument(
            "c1",
            mapOf(
                "name" to "Paws", "phone" to "805-555-0100", "address" to "1 Main St",
                "website" to "https://paws.example", "googleMapsUrl" to "https://maps.example/p", "isEmergency" to true,
            ),
        )
        assertEquals(
            VetClinic("c1", "Paws", "805-555-0100", "1 Main St", "https://paws.example", "https://maps.example/p", true),
            full,
        )
        val sparse = vetClinicFromDocument("c2", mapOf("name" to "X", "phone" to 5L, "isEmergency" to "yes"))
        assertNotNull(sparse)
        assertEquals("", sparse.phone)
        assertEquals("", sparse.website)
        assertEquals(false, sparse.isEmergency)
        assertNull(vetClinicFromDocument("c3", mapOf("phone" to "1")))
    }
}
