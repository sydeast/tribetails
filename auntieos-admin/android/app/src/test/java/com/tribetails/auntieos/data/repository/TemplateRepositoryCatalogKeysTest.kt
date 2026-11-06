package com.tribetails.auntieos.data.repository

import com.google.android.gms.tasks.Tasks
import com.google.firebase.functions.FirebaseFunctions
import com.google.firebase.functions.HttpsCallableReference
import com.google.firebase.functions.HttpsCallableResult
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * TemplateRepository.listCatalogKeys wraps the read-only listCatalogKeys callable,
 * which returns the ROUTING TABLE: every catalog key and the template it sends today.
 * These verify the rows decode, the empty/missing fallbacks, fail-loud propagation,
 * and the pure helpers that turn a row into the words the screen shows.
 * FirebaseFunctions is fully mocked, so no network or Android static init is required.
 */
class TemplateRepositoryCatalogKeysTest {

    private fun repoWith(functions: FirebaseFunctions) = TemplateRepository(functions = functions)

    private fun functionsReturning(data: Any?): FirebaseFunctions {
        val functions = mockk<FirebaseFunctions>()
        val ref = mockk<HttpsCallableReference>()
        val callResult = mockk<HttpsCallableResult>(relaxed = true)
        every { callResult.getData() } returns data
        every { ref.call(any()) } returns Tasks.forResult(callResult)
        every { functions.getHttpsCallable("listCatalogKeys") } returns ref
        return functions
    }

    private fun rowMap(
        key: String,
        resolved: String = key,
        bound: Boolean = false,
        hasDefault: Boolean = true,
    ): Map<String, Any?> = mapOf(
        "key" to key,
        "label" to "Label for $key",
        "category" to "visit",
        "audience" to "both",
        "source" to "catalog",
        "defaultTemplateId" to key,
        "hasDefaultTemplate" to hasDefault,
        "bound" to bound,
        "resolvedTemplateId" to resolved,
    )

    @Test
    fun `listCatalogKeys decodes the routing rows`() = runBlocking {
        val functions = functionsReturning(
            mapOf(
                "keys" to listOf("invoice.new", "kincare.booking.confirm"),
                "rows" to listOf(
                    rowMap("invoice.new", resolved = "tmpl_custom", bound = true),
                    rowMap("kincare.booking.confirm"),
                ),
            ),
        )

        val result = repoWith(functions).listCatalogKeys()
        assertTrue(result.isSuccess)
        val rows = result.getOrNull()!!
        assertEquals(2, rows.size)
        assertEquals("invoice.new", rows[0].key)
        assertEquals("tmpl_custom", rows[0].resolvedTemplateId)
        assertEquals("invoice.new", rows[0].defaultTemplateId)
        assertTrue(rows[0].bound)
        assertEquals("Label for kincare.booking.confirm", rows[1].label)
        assertEquals("catalog", rows[1].source)
    }

    @Test
    fun `listCatalogKeys defaults to empty when rows missing`() = runBlocking {
        val result = repoWith(functionsReturning(mapOf("ok" to true))).listCatalogKeys()
        assertTrue(result.isSuccess)
        assertEquals(emptyList<TemplateRepository.CatalogKey>(), result.getOrNull())
    }

    @Test
    fun `a row missing its default template id falls back to the key, not to blank`() = runBlocking {
        // A blank default would make every key compare as overridden, which is the
        // one decode slip that would misreport the whole table.
        val functions = functionsReturning(
            mapOf("rows" to listOf(mapOf("key" to "invoice.new", "resolvedTemplateId" to "invoice.new"))),
        )
        val rows = repoWith(functions).listCatalogKeys().getOrNull()!!
        assertEquals("invoice.new", rows[0].defaultTemplateId)
        assertFalse(isOverridden(rows[0]))
    }

    @Test
    fun `listCatalogKeys propagates fail-loud message`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val ref = mockk<HttpsCallableReference>()
        every { ref.call(any()) } returns Tasks.forException(RuntimeException("permission-denied: admin only"))
        every { functions.getHttpsCallable("listCatalogKeys") } returns ref

        val result = repoWith(functions).listCatalogKeys()
        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull()!!.message!!.contains("admin only"))
    }

    // ── #384: what the screen says about each row ─────────────────────────────────

    private fun key(
        key: String = "invoice.new",
        default: String = "invoice.new",
        resolved: String = "invoice.new",
        bound: Boolean = false,
        hasDefault: Boolean = true,
    ) = TemplateRepository.CatalogKey(
        key = key,
        label = "New invoice",
        category = "invoice",
        audience = "kinfolk",
        source = "catalog",
        defaultTemplateId = default,
        hasDefaultTemplate = hasDefault,
        bound = bound,
        resolvedTemplateId = resolved,
    )

    @Test fun `a key with no binding routes by name`() {
        val row = key()
        assertFalse(isOverridden(row))
        assertEquals("default, matched by name", routingSource(row))
    }

    @Test fun `a key whose binding steers it elsewhere is an override`() {
        val row = key(resolved = "tmpl_custom", bound = true)
        assertTrue(isOverridden(row))
        assertEquals("override, assigned by an admin", routingSource(row))
    }

    @Test fun `a paused binding is named as paused, not as an override`() {
        // The server already applied resolveTemplateId's rule: inactive falls back to
        // the default, so resolved equals the default even though a binding exists.
        val row = key(bound = true)
        assertFalse(isOverridden(row))
        assertEquals("binding is paused, so the name-matched default applies", routingSource(row))
    }

    @Test fun `a by-name key with no template document is reported missing`() {
        assertTrue(resolvedTemplateMissing(key(hasDefault = false), emptySet(), bankLoaded = true))
        assertFalse(resolvedTemplateMissing(key(hasDefault = true), emptySet(), bankLoaded = true))
    }

    @Test fun `an override is checked against the bank, and only once the bank loaded`() {
        val row = key(resolved = "tmpl_custom", bound = true)
        assertTrue(resolvedTemplateMissing(row, setOf("tmpl_other"), bankLoaded = true))
        assertFalse(resolvedTemplateMissing(row, setOf("tmpl_custom"), bankLoaded = true))
        // Bank unavailable: an empty id set must not paint every override as broken.
        assertFalse(resolvedTemplateMissing(row, emptySet(), bankLoaded = false))
    }

    // #1586: the 2026-11-05 walk. Five keys were called broken; only a direct send
    // with no template can fail, and invite.verify-email now has a repo copy.
    private fun walked(key: String, effect: String, inCorpus: Boolean = true, source: String = "catalog") =
        TemplateRepository.CatalogKey(
            key = key, label = key, category = null, audience = null, source = source,
            defaultTemplateId = key, hasDefaultTemplate = false, bound = false, resolvedTemplateId = key,
            whenTemplateMissing = effect, inRepoCorpus = inCorpus,
        )

    @Test fun `none of the five walked keys fails on send`() {
        val rows = listOf(
            walked("broadcast.message", "unused", inCorpus = false),
            walked("invite.verify-email", "repoCopy", source = "direct-send"),
            walked("kin.removal.archived", "generic"),
            walked("kin.removal.declined", "generic"),
            walked("kin.removal.requested", "generic"),
        )
        assertEquals(0, rows.count { failsOnSend(it, emptySet(), bankLoaded = true) })
        assertEquals(
            listOf("invite.verify-email", "kin.removal.archived", "kin.removal.declined", "kin.removal.requested"),
            rows.filter { awaitingImport(it, emptySet(), bankLoaded = true) }.map { it.key },
        )
    }

    @Test fun `a direct send with no template and no repo copy fails`() {
        val row = walked("invite.primary", "fails", inCorpus = false, source = "direct-send")
        assertTrue(failsOnSend(row, emptySet(), bankLoaded = true))
        assertEquals(null, missingTemplateNote(row, templateMissing = true))
    }

    @Test fun `the quiet note names what goes out instead`() {
        assertEquals(
            "Not in the bank yet, so this sends generic wording that cannot say what happened. Load it from Template Import.",
            missingTemplateNote(walked("kin.removal.requested", "generic"), templateMissing = true),
        )
        assertEquals(
            "Not in the bank yet, so this sends the repo copy. Load it from Template Import.",
            missingTemplateNote(walked("invite.verify-email", "repoCopy"), templateMissing = true),
        )
        assertEquals(
            "Written when it is sent, so no template is used.",
            missingTemplateNote(walked("broadcast.message", "unused"), templateMissing = true),
        )
        assertEquals(null, missingTemplateNote(walked("kin.removal.requested", "generic"), templateMissing = false))
    }

    @Test fun `decode reads the effect, and an old server without it as fails`() = runBlocking {
        val functions = functionsReturning(
            mapOf(
                "rows" to listOf(
                    rowMap("kin.removal.requested", hasDefault = false) +
                        mapOf("whenTemplateMissing" to "generic", "inRepoCorpus" to true),
                    rowMap("old.server.row", hasDefault = false),
                    rowMap("garbage.row") + mapOf("whenTemplateMissing" to "explode"),
                ),
            ),
        )
        val rows = repoWith(functions).listCatalogKeys().getOrThrow()
        assertEquals("generic", rows[0].whenTemplateMissing)
        assertTrue(rows[0].inRepoCorpus)
        assertEquals("fails", rows[1].whenTemplateMissing)
        assertFalse(rows[1].inRepoCorpus)
        assertEquals("fails", rows[2].whenTemplateMissing)
    }
}
