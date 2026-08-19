package com.tribetails.auntieos.data.repository

import com.google.android.gms.tasks.Tasks
import com.google.firebase.functions.FirebaseFunctions
import com.google.firebase.functions.HttpsCallableReference
import com.google.firebase.functions.HttpsCallableResult
import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The phone's half of the template importer, issue #468.
 *
 * Two things are worth pinning here. The payload has to carry `dryRun` honestly,
 * because a caller that meant to plan and accidentally wrote would replace 45
 * templates. And an absent `dryRun` in the RESPONSE has to decode as a dry run,
 * because reading a silent absence as "it wrote" is the one wrong guess with
 * consequences.
 */
class TemplateRepositoryImportTest {

    private fun repoWith(functions: FirebaseFunctions) = TemplateRepository(functions = functions)

    private fun stub(
        name: String,
        data: Any?,
        payload: io.mockk.CapturingSlot<Map<String, Any>>,
    ): FirebaseFunctions {
        val functions = mockk<FirebaseFunctions>()
        val ref = mockk<HttpsCallableReference>()
        val callResult = mockk<HttpsCallableResult>(relaxed = true)
        every { callResult.getData() } returns data
        every { ref.call(capture(payload)) } returns Tasks.forResult(callResult)
        every { functions.getHttpsCallable(name) } returns ref
        return functions
    }

    private fun planPayload() = mapOf(
        "dryRun" to true,
        "written" to 0,
        "counts" to mapOf("create" to 3),
        "rows" to listOf(
            mapOf(
                "templateId" to "kincare.reschedule.requested",
                "aliasOf" to null,
                "channels" to listOf(
                    mapOf("channel" to "email", "outcome" to "create", "notes" to emptyList<String>()),
                    mapOf("channel" to "sms", "outcome" to "create", "notes" to emptyList<String>()),
                    mapOf("channel" to "push", "outcome" to "create", "notes" to emptyList<String>()),
                ),
                "differsFromRepo" to false,
                "blocked" to false,
            ),
        ),
        "needsOverwriteChoice" to emptyList<String>(),
        "refused" to emptyList<Map<String, Any>>(),
    )

    @Test
    fun `importSeedTemplates defaults to a dry run and says so in the payload`() = runBlocking {
        val payload = slot<Map<String, Any>>()
        val result = repoWith(stub("importSeedTemplates", planPayload(), payload)).importSeedTemplates()

        assertTrue(result.isSuccess)
        assertEquals(true, payload.captured["dryRun"])
        // Absent, not empty: an empty list would be a different request.
        assertFalse(payload.captured.containsKey("overwriteIds"))
        assertFalse(payload.captured.containsKey("onlyIds"))
    }

    @Test
    fun `a real run sends dryRun false and the chosen overwrite ids`() = runBlocking {
        val payload = slot<Map<String, Any>>()
        repoWith(stub("importSeedTemplates", planPayload(), payload)).importSeedTemplates(
            dryRun = false,
            overwriteIds = listOf("invoice.new"),
        )

        assertEquals(false, payload.captured["dryRun"])
        assertEquals(listOf("invoice.new"), payload.captured["overwriteIds"])
    }

    @Test
    fun `the plan decodes into rows, channels and counts`() = runBlocking {
        val payload = slot<Map<String, Any>>()
        val report = repoWith(stub("importSeedTemplates", planPayload(), payload))
            .importSeedTemplates().getOrThrow()

        assertTrue(report.dryRun)
        assertEquals(0, report.written)
        assertEquals(3, report.counts["create"])
        assertEquals(1, report.rows.size)
        assertEquals("kincare.reschedule.requested", report.rows[0].templateId)
        assertEquals(listOf("email", "sms", "push"), report.rows[0].channels.map { it.channel })
        assertNull(report.rows[0].aliasOf)
    }

    @Test
    fun `a refusal decodes with its reason attached`() = runBlocking {
        val data = planPayload().toMutableMap().apply {
            put("refused", listOf(mapOf("templateId" to "invoice.new", "reason" to "html uses the triple stash.")))
            put(
                "rows",
                listOf(
                    mapOf(
                        "templateId" to "invoice.new",
                        "channels" to listOf(
                            mapOf(
                                "channel" to "email",
                                "outcome" to "blocked",
                                "notes" to listOf("html uses the triple stash."),
                            ),
                        ),
                        "differsFromRepo" to false,
                        "blocked" to true,
                    ),
                ),
            )
        }
        val payload = slot<Map<String, Any>>()
        val report = repoWith(stub("importSeedTemplates", data, payload)).importSeedTemplates().getOrThrow()

        assertEquals(1, report.refused.size)
        assertEquals("invoice.new" to "html uses the triple stash.", report.refused[0])
        assertTrue(report.rows[0].blocked)
        assertEquals(listOf("html uses the triple stash."), report.rows[0].channels[0].notes)
    }

    @Test
    fun `a response with no dryRun field decodes as a dry run, never as a write`() {
        val report = decodeImportReport(mapOf("rows" to emptyList<Any>()))
        assertTrue(report.dryRun)
        assertEquals(0, report.written)
    }

    @Test
    fun `a row with no templateId is dropped rather than guessed at`() {
        val report = decodeImportReport(
            mapOf(
                "rows" to listOf(
                    mapOf("channels" to emptyList<Any>()),
                    mapOf("templateId" to "invoice.new", "channels" to emptyList<Any>()),
                ),
            ),
        )
        assertEquals(listOf("invoice.new"), report.rows.map { it.templateId })
    }

    @Test
    fun `the alias label survives decoding`() {
        val report = decodeImportReport(
            mapOf(
                "rows" to listOf(
                    mapOf(
                        "templateId" to "kincare.report.sent",
                        "aliasOf" to "kintale.published",
                        "channels" to emptyList<Any>(),
                    ),
                ),
            ),
        )
        assertEquals("kintale.published", report.rows[0].aliasOf)
    }

    @Test
    fun `a failed call surfaces as a failure rather than an empty report`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val ref = mockk<HttpsCallableReference>()
        every { ref.call(any<Map<String, Any>>()) } returns
            Tasks.forException(RuntimeException("permission-denied: admin only"))
        every { functions.getHttpsCallable("importSeedTemplates") } returns ref

        val result = repoWith(functions).importSeedTemplates()

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull()!!.message!!.contains("permission-denied"))
    }
}

/**
 * `expectNew` on save, issue #468. Android's editor checked its own loaded list
 * for a collision, which misses anything not on that page; the flag is how the
 * server gets asked.
 */
class TemplateRepositorySaveExpectNewTest {

    private fun repoWith(functions: FirebaseFunctions) = TemplateRepository(functions = functions)

    private fun template() = TemplateRepository.EmailTemplate(
        templateId = "invoice.new",
        subject = "Your invoice",
        body = "Body copy.",
        html = null,
        title = "Invoice",
        description = null,
        tags = emptyList(),
        category = null,
    )

    private fun stub(payload: io.mockk.CapturingSlot<Map<String, Any>>): FirebaseFunctions {
        val functions = mockk<FirebaseFunctions>()
        val ref = mockk<HttpsCallableReference>()
        val callResult = mockk<HttpsCallableResult>(relaxed = true)
        every { callResult.getData() } returns mapOf("templateId" to "invoice.new")
        every { ref.call(capture(payload)) } returns Tasks.forResult(callResult)
        every { functions.getHttpsCallable("saveTemplate") } returns ref
        return functions
    }

    @Test
    fun `creating sends expectNew`() = runBlocking {
        val payload = slot<Map<String, Any>>()
        repoWith(stub(payload)).saveTemplate(template(), expectNew = true)
        assertEquals(true, payload.captured["expectNew"])
    }

    @Test
    fun `editing omits expectNew, so a save stays an upsert`() = runBlocking {
        val payload = slot<Map<String, Any>>()
        repoWith(stub(payload)).saveTemplate(template())
        assertFalse(payload.captured.containsKey("expectNew"))
    }
}
