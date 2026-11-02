package com.kinfolk.portal.config

import com.kinfolk.portal.components.RoutePoint
import com.kinfolk.portal.firebase.FirestoreClient
import com.kinfolk.portal.firebase.FirestoreDoc
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #1321: the pre-auth business card. The mapping mirrors
 * functions/src/lib/businessPublicCard.ts and the web portal's
 * lib/businessPublicCard.ts; the cache is what puts the business name on a
 * cold sign-in screen with the first frame.
 */
class BusinessPublicCardTest {

    private class ScriptedFirestore(
        private val doc: Map<String, Any?>? = null,
        private val failure: Throwable? = null,
    ) : FirestoreClient {
        val reads = mutableListOf<String>()
        override suspend fun getDocument(collection: String, documentId: String): Map<String, Any?>? {
            reads += "$collection/$documentId"
            failure?.let { throw it }
            return doc
        }
        override suspend fun listDocuments(collection: String): List<FirestoreDoc> = emptyList()
        override fun breadcrumbsStream(sessionId: String): Flow<List<RoutePoint>> = flowOf(emptyList())
    }

    private val closedWeek = PUBLIC_HOURS_DAYS.associateWith { "" }

    @Test
    fun `maps the four public fields and fills every day`() {
        val card = businessPublicCardFromDocument(
            mapOf(
                "name" to "Sunny Paws",
                "phone" to "555-0142",
                "hours" to mapOf("Monday" to "09:00-17:00", "Saturday" to "10:00-14:00", "Funday" to "x"),
                "privacyPolicyUrl" to "https://example.test/privacy",
            ),
        )
        assertEquals("Sunny Paws", card.name)
        assertEquals("555-0142", card.phone)
        assertEquals(closedWeek + mapOf("Monday" to "09:00-17:00", "Saturday" to "10:00-14:00"), card.hours)
        assertEquals(PUBLIC_HOURS_DAYS, card.hours.keys.toList())
        assertEquals("https://example.test/privacy", card.privacyPolicyUrl)
    }

    @Test
    fun `a missing document, a blank name and a bad value read as unset`() {
        assertEquals(BusinessPublicCard(), businessPublicCardFromDocument(null))
        assertEquals(BusinessPublicCard(), businessPublicCardFromDocument(mapOf("name" to "   ", "phone" to 42L, "hours" to "nine to five")))
        assertEquals("", businessPublicCardFromDocument(mapOf("privacyPolicyUrl" to "http://example.test")).privacyPolicyUrl)
        assertEquals("", businessPublicCardFromDocument(mapOf("privacyPolicyUrl" to "javascript:alert(1)")).privacyPolicyUrl)
    }

    @Test
    fun `reads business_public slash card`() = runTest {
        val fs = ScriptedFirestore(mapOf("name" to "Sunny Paws"))
        val card = readBusinessPublicCard(fs)
        assertEquals(listOf("business_public/card"), fs.reads)
        assertEquals("Sunny Paws", card.name)
    }

    @Test
    fun `a document that is not there yet is the empty card`() = runTest {
        assertEquals(BusinessPublicCard(), readBusinessPublicCard(ScriptedFirestore(doc = null)))
    }

    @Test
    fun `a failed read is the caller's to handle`() = runTest {
        assertFailsWith<IllegalStateException> {
            readBusinessPublicCard(ScriptedFirestore(failure = IllegalStateException("UNAVAILABLE")))
        }
    }

    @Test
    fun `the cache round-trips a card`() {
        var stored: String? = null
        val cache = BusinessPublicCardCache(load = { stored }, save = { stored = it })
        assertNull(cache.read())
        val card = BusinessPublicCard(name = "Sunny Paws", phone = "555-0142")
        cache.write(card)
        assertTrue(stored!!.contains("Sunny Paws"))
        assertEquals(card, cache.read())
    }

    @Test
    fun `a corrupt or refusing store reads as nothing and never throws`() {
        assertNull(BusinessPublicCardCache(load = { "{not json" }, save = {}).read())
        assertNull(BusinessPublicCardCache(load = { "\"a string\"" }, save = {}).read())
        assertNull(BusinessPublicCardCache(load = { throw IllegalStateException("locked") }, save = {}).read())
        BusinessPublicCardCache(load = { null }, save = { throw IllegalStateException("full") }).write(BusinessPublicCard(name = "x"))
    }

    @Test
    fun `an older cache entry with extra keys still decodes`() {
        val cache = BusinessPublicCardCache(load = { """{"name":"Sunny Paws","phone":"","hours":{},"privacyPolicyUrl":"","extra":1}""" }, save = {})
        assertEquals("Sunny Paws", cache.read()?.name)
    }
}
