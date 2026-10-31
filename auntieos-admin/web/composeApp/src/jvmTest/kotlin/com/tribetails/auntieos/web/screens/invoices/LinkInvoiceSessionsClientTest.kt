package com.tribetails.auntieos.web.screens.invoices

import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.InvoiceSessionLinkOutcome
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.data.decodeInvoiceSessionLinkOutcome
import com.tribetails.auntieos.web.data.invoiceSessionLinksSavedText
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #1197: the desktop console's Link Sessions save goes through the
 * `linkInvoiceSessions` callable, the one Android calls, and never writes
 * `/invoices` or `/kin_care_sessions` over REST (firestore.rules refuses every
 * client invoice write, ADR-0002).
 *
 * Runs against the jvm `platformInvokeCallable`, which records every payload in
 * [JvmFirestoreFixtures.callablePayloads] and answers from the fixture maps;
 * [JvmFirestoreFixtures.lastWrite] records any direct REST write.
 */
class LinkInvoiceSessionsClientTest {

    @BeforeTest fun setUp() = JvmFirestoreFixtures.clear()
    @AfterTest fun tearDown() = JvmFirestoreFixtures.clear()

    private fun sentBody(): Pair<String, Map<String, kotlinx.serialization.json.JsonElement>> {
        val (name, body) = JvmFirestoreFixtures.callablePayloads.single()
        return name to Json.parseToJsonElement(body).jsonObject
    }

    @Test
    fun saveSendsTheInvoiceIdAndTheFullSetThroughTheCallableOnly() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "linkInvoiceSessions" to
                """{"ok":true,"invoiceId":"inv1","sessionIds":["s1","s2","s3"],"added":["s3"],"removed":["s0"],"status":"open","editScope":"all"}""",
        )
        val r = FirestoreClient().linkInvoiceSessions("inv1", listOf("s1", "s2", "s3", "s2"))
        assertTrue(r is WriteResult.Ok, "$r")

        val (name, sent) = sentBody()
        assertEquals("linkInvoiceSessions", name)
        assertEquals(setOf("invoiceId", "sessionIds"), sent.keys)
        assertEquals("inv1", sent["invoiceId"]!!.jsonPrimitive.content)
        // The FULL set, de-duplicated, never a delta the client computed.
        assertEquals(listOf("s1", "s2", "s3"), sent["sessionIds"]!!.jsonArray.map { it.jsonPrimitive.content })
        // The defect: a direct REST PATCH of invoices/{id} that the rules refuse.
        assertNull(JvmFirestoreFixtures.lastWrite, "no direct REST write may happen")

        val outcome = (r as WriteResult.Ok).value
        assertEquals(listOf("s1", "s2", "s3"), outcome.sessionIds)
        assertEquals(listOf("s3"), outcome.added)
        assertEquals(listOf("s0"), outcome.removed)
        assertEquals("open", outcome.status)
        assertEquals("all", outcome.editScope)
    }

    @Test
    fun anEmptySetIsSentAsAnEmptyArrayToUnlinkEverything() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "linkInvoiceSessions" to
                """{"ok":true,"invoiceId":"inv1","sessionIds":[],"added":[],"removed":["s1","s2"],"status":"open","editScope":"all"}""",
        )
        val r = FirestoreClient().linkInvoiceSessions("inv1", emptyList())
        assertTrue(r is WriteResult.Ok, "$r")
        val (_, sent) = sentBody()
        assertEquals(0, sent["sessionIds"]!!.jsonArray.size)
        assertEquals(emptyList(), (r as WriteResult.Ok).value.sessionIds)
        assertNull(JvmFirestoreFixtures.lastWrite)
    }

    @Test
    fun aRefusalComesBackVerbatimWithItsCode() = runBlocking {
        val refusal = "session_not_found: s9"
        JvmFirestoreFixtures.callableErrors = mapOf("linkInvoiceSessions" to refusal)
        JvmFirestoreFixtures.callableErrorCodes = mapOf("linkInvoiceSessions" to "session_not_found")
        val r = FirestoreClient().linkInvoiceSessions("inv1", listOf("s9"))
        assertTrue(r is WriteResult.Err, "$r")
        assertEquals(refusal, (r as WriteResult.Err).message)
        assertEquals("session_not_found", r.code)
        assertNull(JvmFirestoreFixtures.lastWrite, "a refused save must not fall back to a direct write")
    }

    // ── Decode ──────────────────────────────────────────────────────────────

    @Test
    fun presentAndEmptySessionIdsStayEmpty() {
        val o = decodeInvoiceSessionLinkOutcome(
            """{"ok":true,"invoiceId":"inv1","sessionIds":[],"added":[],"removed":["s1"]}""",
            "inv1",
            listOf("s1"),
        )
        assertEquals(emptyList(), o.sessionIds)
        assertEquals(listOf("s1"), o.removed)
    }

    @Test
    fun anAbsentSessionIdsKeyOrBlankInvoiceIdFallsBackToTheRequest() {
        val o = decodeInvoiceSessionLinkOutcome("""{"ok":true,"invoiceId":""}""", "inv7", listOf("a", "b", "a"))
        assertEquals("inv7", o.invoiceId)
        assertEquals(listOf("a", "b"), o.sessionIds)
        assertEquals(emptyList(), o.added)
        assertEquals(emptyList(), o.removed)
        assertEquals("", o.status)
    }

    @Test
    fun anUnreadableAnswerStillDecodesToTheRequest() {
        val o = decodeInvoiceSessionLinkOutcome("not json", "inv1", listOf("s1"))
        assertEquals("inv1", o.invoiceId)
        assertEquals(listOf("s1"), o.sessionIds)
    }

    @Test
    fun theSavedTextNamesWhatTheServerChanged() {
        fun outcome(added: List<String>, removed: List<String>) =
            InvoiceSessionLinkOutcome("inv1", emptyList(), added, removed, "open", "all")
        assertEquals("Visits saved: 2 linked, 1 unlinked.", invoiceSessionLinksSavedText(outcome(listOf("a", "b"), listOf("c"))))
        assertEquals("Visits saved: 1 linked.", invoiceSessionLinksSavedText(outcome(listOf("a"), emptyList())))
        assertEquals("Visits saved: 3 unlinked.", invoiceSessionLinksSavedText(outcome(emptyList(), listOf("a", "b", "c"))))
        assertEquals("Linked visits unchanged.", invoiceSessionLinksSavedText(outcome(emptyList(), emptyList())))
    }

    // ── Source guard ────────────────────────────────────────────────────────

    /**
     * The direct writers are gone from the console, and the screen's save calls
     * the callable. A REST write of `invoices` or of a visit's `invoiceId`
     * cannot succeed under the rules, so neither may come back.
     */
    @Test
    fun theDirectInvoiceLinkWritersAreGone() {
        val roots = listOf(File("src/commonMain/kotlin"), File("src/jvmMain/kotlin"))
        val sources = roots.flatMap { r -> r.walkTopDown().filter { it.isFile && it.extension == "kt" }.toList() }
        assertTrue(sources.isNotEmpty(), "source walk found nothing from ${roots.map { it.absolutePath }}")
        val offenders = sources.filter { f ->
            val t = f.readText()
            "updateInvoiceSessionIds" in t || "updateSessionInvoiceId" in t ||
                Regex("""patchFields\(\s*"invoices"""").containsMatchIn(t)
        }
        assertEquals(emptyList(), offenders.map { it.path })

        val screen = sources.single { it.name == "InvoiceDetailScreen.kt" }.readText()
        assertTrue("client.linkInvoiceSessions(" in screen, "Link Sessions save must call the callable")
        assertFalse("updateSessionInvoiceId" in screen)
    }
}
