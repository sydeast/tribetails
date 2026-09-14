package com.tribetails.auntieos.data.repository

import com.google.android.gms.tasks.Tasks
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.functions.FirebaseFunctions
import com.google.firebase.functions.HttpsCallableReference
import com.google.firebase.functions.HttpsCallableResult
import com.tribetails.auntieos.data.api.N8nApi
import com.tribetails.auntieos.data.model.ContactOverride
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.domain.TestMode
import io.mockk.coEvery
import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #890: `createKinfolkComplete` creates the household through the `createKinfolk`
 * callable, never a direct Firestore `add`, and follows `duplicateOf`.
 *
 * #829 Fix round 1 still holds on the new wire: the payload carries none of the
 * four Emergency Contact keys and no document id, while every other field the
 * create wrote before rides along.
 *
 * [firestore] is a strict mock with nothing stubbed, so any direct write from the
 * create path fails the test.
 */
class AuntieRepositoryCreateKinfolkTest {

    private val n8nApi = mockk<N8nApi>()
    private val firestore = mockk<FirebaseFirestore>()
    private val functions = mockk<FirebaseFunctions>()
    private val ref = mockk<HttpsCallableReference>()
    private val sent = slot<Any>()

    private fun passingAuthGate(mode: TestMode = TestMode.OFF): AuthGate {
        val gate = mockk<AuthGate>()
        every { gate.ensureAuthenticated() } returns Unit
        coEvery { gate.requireTestMode() } returns mode
        return gate
    }

    private fun repo(gate: AuthGate = passingAuthGate()): AuntieRepository = AuntieRepository(
        n8n = n8nApi,
        authGate = gate,
        functionsOverride = functions,
        firestoreProvider = { firestore },
    )

    private fun answer(data: Any?) {
        val result = mockk<HttpsCallableResult>(relaxed = true)
        every { result.getData() } returns data
        every { ref.call(capture(sent)) } returns Tasks.forResult(result)
        every { functions.getHttpsCallable("createKinfolk") } returns ref
    }

    @Suppress("UNCHECKED_CAST")
    private fun sentKinfolk(): Map<String, Any?> = (sent.captured as Map<String, Any?>)["kinfolk"] as Map<String, Any?>

    private val excludedKeys = listOf(
        "emergencyContacts",
        "emergencyContactName",
        "emergencyContactPhone",
        "emergencyContactRelation",
    )

    private val input = Kinfolk(
        firstName = "Jamie",
        lastName = "Halbrook",
        phoneNumber = "8055550134",
        serviceAddress = "1 Bark Ave",
        internalNotes = "Referred by a neighbor",
    )

    @Test
    fun `createKinfolkComplete calls createKinfolk with no Emergency Contact key and every other field`() = runBlocking {
        answer(mapOf("kinfolkId" to "kf-new", "duplicateOf" to null))

        val result = repo().createKinfolkComplete(input)

        assertTrue(result.isSuccess)
        assertEquals("kf-new", result.getOrNull()?.id)
        val payload = sentKinfolk()
        for (key in excludedKeys) {
            assertFalse("$key must never be written by the client (#829)", payload.containsKey(key))
        }
        assertFalse("the document id is never part of the document's own content", payload.containsKey("id"))
        assertEquals("Jamie", payload["firstName"])
        assertEquals("Halbrook", payload["lastName"])
        assertEquals("8055550134", payload["phoneNumber"])
        assertEquals("1 Bark Ave", payload["serviceAddress"])
        assertEquals("Referred by a neighbor", payload["internalNotes"])
        assertEquals("active", payload["status"])
    }

    @Test
    fun `a duplicateOf answer returns the existing household, so Add continues it`() = runBlocking {
        answer(mapOf("kinfolkId" to "kf-existing", "duplicateOf" to "kf-existing"))

        val result = repo().createKinfolkComplete(input)

        assertEquals("kf-existing", result.getOrThrow().id)
        assertEquals("Jamie", result.getOrThrow().firstName)
    }

    @Test
    fun `an answer with no household id is a failure, never a blank id`() = runBlocking {
        answer(mapOf("duplicateOf" to null))
        val result = repo().createKinfolkComplete(input)
        assertTrue(result.isFailure)
        assertEquals("createKinfolk returned no household id", result.exceptionOrNull()?.message)
    }

    @Test
    fun `a nested contact override crosses the callable wire as a plain map`() = runBlocking {
        answer(mapOf("kinfolkId" to "kf-new", "duplicateOf" to null))

        repo().createKinfolkComplete(input.copy(contactOverride = ContactOverride(channel = "text", note = "on vacation")))

        @Suppress("UNCHECKED_CAST")
        val override = sentKinfolk()["contactOverride"] as Map<String, Any?>
        assertEquals("text", override["channel"])
        assertEquals("on vacation", override["note"])
    }
}
