package com.tribetails.auntieos.web.screens.admin

import com.tribetails.auntieos.web.data.CatalogKeyRow
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.TemplateService
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.data.keysAwaitingImport
import com.tribetails.auntieos.web.data.keysFailingOnSend
import kotlinx.coroutines.runBlocking
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * #1586: Manage assignments said five keys had no template and would fail. Only
 * a direct send with no template can fail: the email channel sends generic
 * wording, a direct send with a repo copy sends that, and a broadcast never
 * reads a template. The desktop console now reads the server's
 * `whenTemplateMissing` and names only the keys that really fail.
 */
class TemplateMissingEffectClientTest {

    @AfterTest
    fun tearDown() {
        JvmFirestoreFixtures.callableResponses = emptyMap()
        JvmFirestoreFixtures.callableErrors = emptyMap()
    }

    private fun row(key: String, effect: String, corpus: Boolean = true, source: String = "catalog") = CatalogKeyRow(
        key = key,
        source = source,
        defaultTemplateId = key,
        hasDefaultTemplate = false,
        bound = false,
        resolvedTemplateId = key,
        whenTemplateMissing = effect,
        inRepoCorpus = corpus,
    )

    private val walked = listOf(
        row("broadcast.message", "unused", corpus = false),
        row("invite.verify-email", "repoCopy", source = "direct-send"),
        row("kin.removal.archived", "generic"),
        row("kin.removal.declined", "generic"),
        row("kin.removal.requested", "generic"),
    )

    @Test
    fun noneOfTheFiveWalkedKeysFailsOnSend() {
        assertEquals(emptyList(), keysFailingOnSend(walked, emptySet(), bankLoaded = true))
    }

    @Test
    fun theFourWithARepoCopyAreListedForTemplateImport() {
        assertEquals(
            listOf("invite.verify-email", "kin.removal.archived", "kin.removal.declined", "kin.removal.requested"),
            keysAwaitingImport(walked, emptySet(), bankLoaded = true),
        )
    }

    @Test
    fun aDirectSendWithNoTemplateAndNoRepoCopyFails() {
        val rows = listOf(row("invite.primary", "fails", corpus = false, source = "direct-send"))
        assertEquals(listOf("invite.primary"), keysFailingOnSend(rows, emptySet(), bankLoaded = true))
        assertEquals(emptyList(), keysAwaitingImport(rows, emptySet(), bankLoaded = true))
    }

    @Test
    fun aKeyWhoseTemplateExistsIsNeitherFailingNorAwaiting() {
        val rows = listOf(row("invite.primary", "fails", corpus = false).copy(hasDefaultTemplate = true))
        assertEquals(emptyList(), keysFailingOnSend(rows, emptySet(), bankLoaded = true))
    }

    @Test
    fun decodesTheRowsAndReadsAnOldServerAsFailing() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "listCatalogKeys" to """
                {"keys":["kin.removal.requested","old.row"],"rows":[
                  {"key":"kin.removal.requested","source":"catalog","defaultTemplateId":"kin.removal.requested",
                   "hasDefaultTemplate":false,"bound":false,"resolvedTemplateId":"kin.removal.requested",
                   "whenTemplateMissing":"generic","inRepoCorpus":true},
                  {"key":"old.row","source":"direct-send","hasDefaultTemplate":false}
                ]}
            """.trimIndent(),
        )
        val r = TemplateService().listCatalogKeyRows()
        assertTrue(r is WriteResult.Ok)
        val rows = (r as WriteResult.Ok).value
        assertEquals("generic", rows[0].whenTemplateMissing)
        assertTrue(rows[0].inRepoCorpus)
        assertEquals("fails", rows[1].whenTemplateMissing)
        assertFalse(rows[1].inRepoCorpus)
        assertEquals("old.row", rows[1].resolvedTemplateId)
    }

    @Test
    fun aCallableFailureIsAnErrNotAnEmptyTable() = runBlocking {
        JvmFirestoreFixtures.callableErrors = mapOf("listCatalogKeys" to "permission-denied")
        val r = TemplateService().listCatalogKeyRows()
        assertTrue(r is WriteResult.Err)
        assertEquals("permission-denied", (r as WriteResult.Err).message)
    }
}
