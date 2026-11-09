package com.tribetails.auntieos.data.repository

import com.google.android.gms.tasks.Tasks
import com.google.firebase.functions.FirebaseFunctions
import com.google.firebase.functions.FirebaseFunctionsException
import com.google.firebase.functions.HttpsCallableReference
import com.google.firebase.functions.HttpsCallableResult
import com.tribetails.auntieos.data.api.N8nApi
import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.model.PortalHomeSection
import com.tribetails.auntieos.data.model.TagColor
import com.tribetails.auntieos.data.model.TagDef
import com.tribetails.auntieos.data.model.TimeBlockDefinition
import com.tribetails.auntieos.data.model.TrackingAccuracy
import com.tribetails.auntieos.data.model.businessSettingsFieldChanges
import com.tribetails.auntieos.data.model.businessSettingsWireChanges
import com.tribetails.auntieos.data.model.withHomeSections
import com.tribetails.auntieos.data.model.withHouseholdTagDefs
import com.tribetails.auntieos.data.model.withPaymentDraft
import com.tribetails.auntieos.data.model.paymentDraftOf
import com.tribetails.auntieos.ui.admin.settingsRefusalOf
import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
import io.mockk.verify
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #1593: THE WIRE for `AuntieRepository.updateBusinessSettingsFields`, which now
 * goes through the `saveBusinessSettings` callable instead of a Firestore `.set()`.
 *
 * The view-model tests mock this method out, so every case there would still
 * pass with the callable misspelled, a stamp still sent, or a Kotlin class handed
 * to a serializer that cannot carry it. Those failures only show up here, and in
 * production each of them is "Settings will not save" with nothing else to go on.
 *
 * The shape pins are per complex field: the callable serializer takes primitives,
 * String, Map, List and null only, so each field that used to ride Firestore's
 * POJO mapper must arrive as plain data under the names that mapper wrote.
 */
class AuntieRepositorySaveBusinessSettingsTest {

    private val n8nApi = mockk<N8nApi>()

    private fun passingAuthGate(): AuthGate {
        val gate = mockk<AuthGate>()
        every { gate.ensureAuthenticated() } returns Unit
        return gate
    }

    private fun repoWith(functions: FirebaseFunctions, authGate: AuthGate = passingAuthGate()) =
        AuntieRepository(n8n = n8nApi, authGate = authGate, functionsOverride = functions)

    /** Stubs the callable and returns the slot its one argument lands in. */
    private fun stub(functions: FirebaseFunctions): io.mockk.CapturingSlot<Any> {
        val ref = mockk<HttpsCallableReference>()
        val callResult = mockk<HttpsCallableResult>(relaxed = true)
        every { callResult.getData() } returns mapOf("updatedAt" to "2026-11-09T00:00:00Z", "updatedBy" to "a@b.c")
        val payload = slot<Any>()
        every { ref.call(capture(payload)) } returns Tasks.forResult(callResult)
        every { functions.getHttpsCallable("saveBusinessSettings") } returns ref
        return payload
    }

    @Suppress("UNCHECKED_CAST")
    private fun changesOf(payload: Any): Map<String, Any?> {
        val outer = payload as Map<String, Any?>
        assertEquals("the request is { changes } and nothing else", setOf("changes"), outer.keys)
        return outer["changes"] as Map<String, Any?>
    }

    @Test
    fun `it calls saveBusinessSettings with the changed fields and no stamp`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val payload = stub(functions)

        val result = repoWith(functions).updateBusinessSettingsFields(mapOf("venmoHandle" to "tribe-tails"), "admin")

        assertTrue(result.isSuccess)
        verify(exactly = 1) { functions.getHttpsCallable("saveBusinessSettings") }
        val changes = changesOf(payload.captured)
        assertEquals(mapOf("venmoHandle" to "tribe-tails"), changes)
        assertFalse(changes.containsKey("updatedAt"))
        assertFalse(changes.containsKey("updatedBy"))
    }

    @Test
    fun `an explicit null survives, because null is how a send hour is cleared`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val payload = stub(functions)

        repoWith(functions).updateBusinessSettingsFields(mapOf("scheduleDigestHour" to null)).getOrThrow()

        val changes = changesOf(payload.captured)
        assertTrue(changes.containsKey("scheduleDigestHour"))
        assertEquals(null, changes["scheduleDigestHour"])
    }

    @Test
    fun `time blocks go out as plain maps named the way Firestore stored them`() {
        val wire = businessSettingsWireChanges(
            mapOf(
                "timeBlocks" to listOf(
                    TimeBlockDefinition(id = "am", label = "Morning", startTime = "08:00", endTime = "11:00", isActive = true),
                    TimeBlockDefinition(id = "pm", label = "Evening", startTime = "17:00", endTime = "20:00", isActive = false),
                ),
            ),
        )
        assertEquals(
            listOf(
                mapOf("id" to "am", "label" to "Morning", "startTime" to "08:00", "endTime" to "11:00", "active" to true),
                mapOf("id" to "pm", "label" to "Evening", "startTime" to "17:00", "endTime" to "20:00", "active" to false),
            ),
            wire["timeBlocks"],
        )
        @Suppress("UNCHECKED_CAST")
        val first = (wire["timeBlocks"] as List<Map<String, Any?>>).first()
        assertFalse("the server reads `active`; `isActive` would be refused", first.containsKey("isActive"))
    }

    @Test
    fun `tracking accuracy and the rate card are plain values`() {
        val loaded = BusinessSettings()
        val edited = loaded.copy(
            trackingAccuracy = TrackingAccuracy.LOW,
            serviceRates = mapOf("30 min" to "25", "Overnight" to ""),
            serviceDurations = mapOf("30 min" to "30"),
            serviceStartTimeBooking = mapOf("Overnight" to true),
            etaMinuteOptions = listOf(5, 10),
        )
        val wire = businessSettingsWireChanges(businessSettingsFieldChanges(loaded, edited))
        assertEquals("LOW", wire["trackingAccuracy"])
        assertEquals(mapOf("30 min" to "25", "Overnight" to ""), wire["serviceRates"])
        assertEquals(mapOf("30 min" to "30"), wire["serviceDurations"])
        assertEquals(mapOf("Overnight" to true), wire["serviceStartTimeBooking"])
        assertEquals(listOf(5, 10), wire["etaMinuteOptions"])
    }

    @Test
    fun `a tag vocabulary is a list of name, color and icon maps`() {
        val loaded = BusinessSettings()
        val edited = loaded.withHouseholdTagDefs(
            listOf(TagDef(name = "VIP", color = TagColor(token = "gold", css = "#c9a227"), icon = "star")),
        )
        val wire = businessSettingsWireChanges(businessSettingsFieldChanges(loaded, edited))
        assertEquals(
            listOf(mapOf("name" to "VIP", "color" to mapOf("token" to "gold", "css" to "#c9a227"), "icon" to "star")),
            wire["householdTags"],
        )
    }

    @Test
    fun `the portal map keeps its sibling keys, and a stored Long goes out as a plain number`() {
        // Firestore hands integers back as Long; the stored chat limit is one.
        val loaded = BusinessSettings(
            mytribePortal = mapOf(
                "themeId" to "midnight",
                "chat" to mapOf("enabled" to true, "maxMessageLength" to 500L),
                "home" to mapOf("sections" to listOf(mapOf("id" to "visits", "enabled" to true, "limit" to 3L))),
            ),
        )
        val edited = loaded.withHomeSections(listOf(PortalHomeSection(id = "visits", enabled = false, limit = 5)))
        val wire = businessSettingsWireChanges(businessSettingsFieldChanges(loaded, edited))
        assertEquals(
            mapOf(
                "themeId" to "midnight",
                "chat" to mapOf("enabled" to true, "maxMessageLength" to 500),
                "home" to mapOf("sections" to listOf(mapOf("id" to "visits", "enabled" to false, "limit" to 5))),
            ),
            wire["mytribePortal"],
        )
        @Suppress("UNCHECKED_CAST")
        val chat = (wire["mytribePortal"] as Map<String, Any?>)["chat"] as Map<String, Any?>
        assertTrue(chat["maxMessageLength"] is Int)
    }

    @Test
    fun `payment options are a map of method id to enabled and instructions`() {
        val loaded = BusinessSettings()
        val draft = paymentDraftOf(loaded).let { d ->
            d.copy(options = d.options.mapValues { (id, o) -> if (id == "zelle") o.copy(enabled = true, instructions = "Send to 555") else o })
        }
        val edited = loaded.withPaymentDraft(draft)
        val wire = businessSettingsWireChanges(businessSettingsFieldChanges(loaded, edited))
        @Suppress("UNCHECKED_CAST")
        val options = wire["paymentOptions"] as Map<String, Map<String, Any?>>
        assertEquals(mapOf("enabled" to true, "instructions" to "Send to 555"), options["zelle"])
        options.values.forEach { entry ->
            assertTrue(entry["enabled"] is Boolean)
            assertTrue(entry["instructions"] is String)
        }
    }

    @Test
    fun `every field the differ can return is sendable`() {
        // A model with every complex field populated, diffed against the default.
        val loaded = BusinessSettings()
        val edited = BusinessSettings(
            businessName = "Tribe Tails",
            timeBlocks = listOf(TimeBlockDefinition(id = "x", label = "X", startTime = "09:00", endTime = "10:00", isActive = true)),
            trackingAccuracy = TrackingAccuracy.MEDIUM,
            householdNotificationHour = 9,
        ).withHouseholdTagDefs(listOf(TagDef(name = "A", color = TagColor(token = "t", css = "c"), icon = "")))
            .withHomeSections(listOf(PortalHomeSection(id = "visits", enabled = true, limit = 0)))
        val wire = businessSettingsWireChanges(businessSettingsFieldChanges(loaded, edited))
        fun plain(v: Any?): Boolean = when (v) {
            null, is String, is Boolean, is Int, is Double -> true
            is Map<*, *> -> v.keys.all { it is String } && v.values.all(::plain)
            is List<*> -> v.all(::plain)
            else -> false
        }
        wire.forEach { (field, value) -> assertTrue("$field is not plain data: $value", plain(value)) }
    }

    @Test
    fun `a value the serializer cannot carry is refused before the call, naming the field`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        stub(functions)

        val result = repoWith(functions).updateBusinessSettingsFields(mapOf("mytribePortal" to mapOf("x" to Any())))

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull()!!.message!!.startsWith("mytribePortal "))
        verify(exactly = 0) { functions.getHttpsCallable(any()) }
    }

    @Test
    fun `a refusal reaches the caller with its sentence and its details`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val refusal = mockk<FirebaseFunctionsException>()
        every { refusal.cause } returns null
        every { refusal.code } returns FirebaseFunctionsException.Code.INVALID_ARGUMENT
        val sentence = "Enter the price for \"Walk\" in dollars, like 25 or 25.50."
        every { refusal.message } returns sentence
        every { refusal.details } returns mapOf(
            "code" to "settings_refused",
            "field" to "serviceRates",
            "refusals" to listOf(mapOf("field" to "serviceRates", "message" to sentence)),
        )
        val ref = mockk<HttpsCallableReference>()
        every { ref.call(any()) } returns Tasks.forException(refusal)
        every { functions.getHttpsCallable("saveBusinessSettings") } returns ref

        val error = repoWith(functions).updateBusinessSettingsFields(mapOf("serviceRates" to mapOf("Walk" to "abc")))
            .exceptionOrNull()

        assertNotNull(error)
        assertEquals(sentence, error!!.message)
        val parsed = settingsRefusalOf(error)
        assertNotNull(parsed)
        assertEquals("serviceRates", parsed!!.field)
        assertEquals(sentence, parsed.message)
    }

    @Test
    fun `a signed-out caller never reaches the wire`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val gate = mockk<AuthGate>()
        every { gate.ensureAuthenticated() } throws IllegalStateException("Not signed in")

        val result = repoWith(functions, gate).updateBusinessSettingsFields(mapOf("venmoHandle" to "x"))

        assertTrue(result.isFailure)
        verify(exactly = 0) { functions.getHttpsCallable(any()) }
    }
}
