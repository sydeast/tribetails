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
import org.junit.Assert.assertTrue
import org.junit.Test

/** #953 PR 5: the visual format through the callables. FirebaseFunctions is mocked. */
class TemplateRepositoryVisualTest {

    private val visual = TemplateRepository.EmailTemplate(
        templateId = "auth.password.reset", subject = "Reset", body = "", html = null,
        title = "Password reset", description = "", tags = listOf("auth"), category = "Account",
        format = "visual", headline = "Reset your password", content = "<p>Hi</p>",
    )

    private fun functionsFor(name: String, data: Any?, payload: io.mockk.CapturingSlot<Map<String, Any>> = slot()): FirebaseFunctions {
        val functions = mockk<FirebaseFunctions>()
        val ref = mockk<HttpsCallableReference>()
        val result = mockk<HttpsCallableResult>(relaxed = true)
        every { result.getData() } returns data
        every { ref.call(capture(payload)) } returns Tasks.forResult(result)
        every { functions.getHttpsCallable(name) } returns ref
        return functions
    }

    @Test
    fun `listTemplates decodes format, headline and content`() = runBlocking {
        val functions = functionsFor(
            "listTemplates",
            mapOf("templates" to listOf(mapOf(
                "templateId" to "auth.password.reset", "subject" to "Reset", "body" to "", "html" to null,
                "format" to "visual", "headline" to "Reset your password", "content" to "<p>Hi</p>",
            ))),
        )
        val t = TemplateRepository(functions).listTemplates().getOrThrow().single()
        assertEquals("visual", t.format)
        assertEquals("Reset your password", t.headline)
        assertEquals("<p>Hi</p>", t.content)
    }

    @Test
    fun `a visual save sends format, headline and content and never body or html`() {
        val p = saveTemplatePayload(visual, expectNew = false)
        assertEquals(
            setOf("templateId", "subject", "format", "headline", "content", "title", "description", "tags", "category"),
            p.keys,
        )
        assertEquals("visual", p["format"])
        assertEquals("<p>Hi</p>", p["content"])
        assertEquals("", p["description"])
        assertFalse(p.containsKey("body"))
        assertFalse(p.containsKey("html"))
    }

    @Test
    fun `an old-format save is unchanged`() {
        val old = visual.copy(format = null, headline = null, content = null, body = "Body", html = "<p>h</p>", description = null, category = null)
        val p = saveTemplatePayload(old, expectNew = true)
        assertEquals(listOf("templateId", "subject", "body", "html", "title", "tags", "expectNew"), p.keys.toList())
        assertEquals("Body", p["body"])
        assertEquals("<p>h</p>", p["html"])
    }

    @Test
    fun `saveTemplate sends the payload built for it`() = runBlocking {
        val payload = slot<Map<String, Any>>()
        val functions = functionsFor("saveTemplate", mapOf("templateId" to "auth.password.reset"), payload)
        assertTrue(TemplateRepository(functions).saveTemplate(visual).isSuccess)
        assertEquals(saveTemplatePayload(visual, expectNew = false), payload.captured)
    }

    @Test
    fun `previewEmailTemplate sends the draft and decodes the render`() = runBlocking {
        val payload = slot<Map<String, Any>>()
        val functions = functionsFor(
            "previewEmailTemplate",
            mapOf("subject" to "Reset", "html" to "<html>framed</html>", "text" to "framed", "issues" to listOf("Removed an image that is not from your Cloudinary library.")),
            payload,
        )
        val preview = TemplateRepository(functions).previewEmailTemplate("Reset", "Headline", "<p>Hi</p>", "auth.password.reset").getOrThrow()
        assertEquals(mapOf("subject" to "Reset", "headline" to "Headline", "content" to "<p>Hi</p>", "catalogKey" to "auth.password.reset"), payload.captured)
        assertEquals("<html>framed</html>", preview.html)
        assertEquals("framed", preview.text)
        assertEquals(listOf("Removed an image that is not from your Cloudinary library."), preview.issues)
    }

    @Test
    fun `previewEmailTemplate leaves out a blank catalogKey`() = runBlocking {
        val payload = slot<Map<String, Any>>()
        val functions = functionsFor("previewEmailTemplate", mapOf("subject" to "s", "html" to "<p/>", "text" to "t", "issues" to emptyList<String>()), payload)
        TemplateRepository(functions).previewEmailTemplate("s", "h", "<p>c</p>", " ").getOrThrow()
        assertFalse(payload.captured.containsKey("catalogKey"))
    }

    @Test
    fun `previewEmailTemplate fails loud on a payload with no html`() = runBlocking {
        val functions = functionsFor("previewEmailTemplate", mapOf("subject" to "s", "text" to "t"))
        val r = TemplateRepository(functions).previewEmailTemplate("s", "h", "<p>c</p>", null)
        assertTrue(r.isFailure)
        assertTrue(r.exceptionOrNull()!!.message!!.contains("missing html"))
    }
}
