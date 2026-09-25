package com.tribetails.auntieos.ui.admin

import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import com.tribetails.auntieos.data.repository.TemplateRepository
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.withContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows
import org.robolectric.annotation.Config

/** #953 PR 5: the Android visual editor, driven like an operator would. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w400dp-h3000dp")
class VisualTemplateEditorUiTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<ComponentActivity>()

    private val img = "https://res.cloudinary.com/tribetails/image/upload/v1/brand/pup.jpg"
    private val template = TemplateRepository.EmailTemplate(
        templateId = "auth.password.reset", subject = "Reset your password", body = "", html = null,
        title = "Password reset", description = "Sent on request", tags = listOf("auth"), category = "Account",
        format = "visual", headline = "Choose a new password",
        content = "<p>Hi <strong>{{displayName}}</strong>, tap below.</p>" +
            "<p><a href=\"{{link}}\" class=\"button\">Reset Password</a></p>" +
            "<p><img src=\"$img\" alt=\"pup\" /></p>",
    )
    private val preview = TemplateRepository.EmailPreview("Reset your password", "<html><body>framed</body></html>", "framed", emptyList())
    private val blockFields = SemanticsMatcher("an email block field") {
        it.config.getOrNull(SemanticsProperties.TestTag)?.startsWith("email-block-") == true
    }

    private fun editor(
        loadPreview: suspend (EmailPreviewRequest) -> Result<TemplateRepository.EmailPreview> = { Result.success(preview) },
        saving: Boolean = false,
        saveError: String? = null,
        onSave: (TemplateRepository.EmailTemplate) -> Unit = {},
        debounceMs: Long = 0,
    ): @androidx.compose.runtime.Composable () -> Unit = {
        AuntieOSTheme {
            VisualTemplateEditorScreen(
                template = template, categories = emptyList(), saving = saving, saveError = saveError,
                onDismissError = {}, onDismiss = {}, onSave = onSave, loadPreview = loadPreview, previewDebounceMs = debounceMs,
            )
        }
    }

    private fun webView(): WebView {
        fun find(v: View): WebView? = when (v) {
            is WebView -> v
            is ViewGroup -> (0 until v.childCount).firstNotNullOfOrNull { find(v.getChildAt(it)) }
            else -> null
        }
        return find(composeRule.activity.window.decorView) ?: error("no WebView on screen")
    }

    @Test
    fun `a word edit keeps the bold, the button and the image`() {
        var saved: TemplateRepository.EmailTemplate? = null
        composeRule.setContent(editor(onSave = { saved = it }))
        composeRule.onNodeWithTag(blockTag(0)).performTextReplacement("Hi {{displayName}}, tap the button.")
        composeRule.onNodeWithTag(VISUAL_SAVE_TAG).performClick()
        assertEquals(
            "<p>Hi <strong>{{displayName}}</strong>, tap the button.</p>" +
                "<p><a href=\"{{link}}\" class=\"button\">Reset Password</a></p>" +
                "<p><img src=\"$img\" alt=\"pup\" /></p>",
            saved!!.content,
        )
        assertEquals("visual", saved!!.format)
        assertEquals(template.tags, saved!!.tags)
        assertEquals(template.description, saved!!.description)
    }

    @Test
    fun `the button label is editable and its target is shown, locked`() {
        var saved: TemplateRepository.EmailTemplate? = null
        composeRule.setContent(editor(onSave = { saved = it }))
        composeRule.onNodeWithText("{{link}}").assertExists().assert(!hasSetTextAction())
        composeRule.onNodeWithTag(blockTag(1)).performTextReplacement("Choose a new password")
        composeRule.onNodeWithTag(VISUAL_SAVE_TAG).performClick()
        assertTrue(saved!!.content!!.contains("<a href=\"{{link}}\" class=\"button\">Choose a new password</a>"))
    }

    @Test
    fun `a refused edit explains itself and keeps the text`() {
        composeRule.setContent(editor())
        composeRule.onNodeWithTag(blockTag(0)).performTextReplacement("Hi {{dispXlayName}}, tap below.")
        composeRule.onNodeWithText(EDIT_WHOLE_MERGE_FIELD).assertExists()
        composeRule.onNodeWithTag(blockTag(0)).assertTextEquals("Hi {{displayName}}, tap below.")
    }

    @Test
    fun `the image is shown and locked, and the block count never changes`() {
        composeRule.setContent(editor())
        composeRule.onNodeWithContentDescription("pup").assertExists()
        composeRule.onNodeWithTag(imageTag(2)).assert(!hasSetTextAction())
        composeRule.onAllNodes(blockFields).assertCountEquals(2)
        composeRule.onNodeWithTag(blockTag(0)).performTextReplacement("Hi {{displayName}}, tap the button.")
        composeRule.onNodeWithTag(blockTag(1)).performTextReplacement("Go")
        composeRule.onAllNodes(blockFields).assertCountEquals(2)
    }

    @Test
    fun `the preview shows a loading cue until the server answers, then the email`() {
        val answer = CompletableDeferred<Result<TemplateRepository.EmailPreview>>()
        composeRule.setContent(editor(loadPreview = { answer.await() }))
        composeRule.onNodeWithText(PREVIEW_LOADING_TEXT).assertExists()
        composeRule.onNodeWithTag(PREVIEW_WEB_TAG).assertDoesNotExist()
        answer.complete(Result.success(preview))
        composeRule.waitForIdle()
        composeRule.onNodeWithText(PREVIEW_LOADING_TEXT).assertDoesNotExist()
        composeRule.onNodeWithTag(PREVIEW_WEB_TAG).assertExists()
        assertEquals(preview.html, Shadows.shadowOf(webView()).lastLoadDataWithBaseURL.data)
    }

    @Test
    fun `a failed preview says so, and Retry asks again`() {
        var calls = 0
        composeRule.setContent(editor(loadPreview = {
            calls++
            if (calls == 1) Result.failure(RuntimeException("deadline-exceeded")) else Result.success(preview)
        }))
        composeRule.waitForIdle()
        composeRule.onNodeWithText("deadline-exceeded").assertExists()
        composeRule.onNodeWithText("Retry").performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithText("deadline-exceeded").assertDoesNotExist()
        composeRule.onNodeWithTag(PREVIEW_WEB_TAG).assertExists()
        assertEquals(2, calls)
    }

    // Review Focus 5
    @Test
    fun `Save works while the preview is still loading, and sends the draft on screen`() {
        var saved: TemplateRepository.EmailTemplate? = null
        composeRule.setContent(editor(loadPreview = { awaitCancellation() }, onSave = { saved = it }))
        composeRule.onNodeWithTag(blockTag(0)).performTextReplacement("Hi {{displayName}}, tap the button.")
        composeRule.onNodeWithTag(VISUAL_SAVE_TAG).performClick()
        composeRule.onNodeWithText(PREVIEW_LOADING_TEXT).assertExists()
        assertTrue(saved!!.content!!.startsWith("<p>Hi <strong>{{displayName}}</strong>, tap the button.</p>"))
    }

    @Test
    fun `while a save is in flight, Save cannot fire again`() {
        var count = 0
        composeRule.setContent(editor(saving = true, onSave = { count++ }))
        composeRule.onNodeWithTag(VISUAL_SAVE_TAG).performClick()
        assertEquals(0, count)
    }

    // Review Focus 4
    @Test
    fun `rotating mid-edit keeps the edit`() {
        var saved: TemplateRepository.EmailTemplate? = null
        val tester = StateRestorationTester(composeRule)
        tester.setContent(editor(onSave = { saved = it }))
        composeRule.onNodeWithTag(blockTag(0)).performTextReplacement("Hi {{displayName}}, tap the button.")
        composeRule.onNodeWithText("Reset your password").performTextReplacement("Reset it")
        tester.emulateSavedInstanceStateRestore()
        composeRule.onNodeWithTag(blockTag(0)).assertTextEquals("Hi {{displayName}}, tap the button.")
        composeRule.onNodeWithTag(VISUAL_SAVE_TAG).performClick()
        assertEquals("Reset it", saved!!.subject)
        assertTrue(saved!!.content!!.startsWith("<p>Hi <strong>{{displayName}}</strong>, tap the button.</p>"))
    }

    // Review Focus 3: a half-typed merge field keeps Save off and says why.
    @Test
    fun `a half-typed merge field keeps Save off`() {
        var count = 0
        composeRule.setContent(editor(onSave = { count++ }))
        composeRule.onNodeWithText("Reset your password").performTextReplacement("Hi {{na")
        composeRule.onNodeWithText(DRAFT_BROKEN_MERGE_FIELD).assertExists()
        composeRule.onNodeWithTag(VISUAL_SAVE_TAG).performClick()
        assertEquals(0, count)
    }

    @Test
    fun `the server's save refusal is shown word for word`() {
        val msg = "content: <script> is not allowed in an email body."
        composeRule.setContent(editor(saveError = msg))
        composeRule.onNodeWithText(msg).assertExists()
    }

    @Test
    fun `the preview runs no script, opens no files and follows no link`() {
        composeRule.setContent(editor())
        composeRule.waitForIdle()
        val web = webView()
        assertFalse(web.settings.javaScriptEnabled)
        assertFalse(web.settings.allowFileAccess)
        assertFalse(web.settings.allowContentAccess)
        val client = Shadows.shadowOf(web).webViewClient
        val tap = object : android.webkit.WebResourceRequest {
            override fun getUrl() = android.net.Uri.parse("https://example.com/")
            override fun isForMainFrame() = true
            override fun isRedirect() = false
            override fun hasGesture() = true
            override fun getMethod() = "GET"
            override fun getRequestHeaders(): Map<String, String> = emptyMap()
        }
        assertTrue(client.shouldOverrideUrlLoading(web, tap))
    }

    @Test
    fun `an answer for an older draft never replaces the newer one`() {
        val older = CompletableDeferred<Result<TemplateRepository.EmailPreview>>()
        val asked = mutableListOf<EmailPreviewRequest>()
        val newer = preview.copy(html = "<html><body>newer</body></html>")
        composeRule.setContent(editor(loadPreview = { request ->
            asked += request
            if (asked.size == 1) {
                // A loader that ignores cancellation: only the screen's own guard can drop its answer.
                withContext(NonCancellable) { older.await() }
            } else {
                Result.success(newer)
            }
        }))
        composeRule.waitForIdle()
        composeRule.onNodeWithTag(blockTag(0)).performTextReplacement("Hi {{displayName}}, tap the button.")
        composeRule.waitForIdle()
        assertEquals(newer.html, Shadows.shadowOf(webView()).lastLoadDataWithBaseURL.data)
        older.complete(Result.success(preview.copy(html = "<html><body>older</body></html>")))
        composeRule.waitForIdle()
        assertEquals(newer.html, Shadows.shadowOf(webView()).lastLoadDataWithBaseURL.data)
        assertEquals(2, asked.size)
        assertTrue(asked[1].content.startsWith("<p>Hi <strong>{{displayName}}</strong>, tap the button.</p>"))
    }

    @Test
    fun `the preview waits for typing to pause`() {
        var calls = 0
        composeRule.mainClock.autoAdvance = false
        composeRule.setContent(editor(loadPreview = { calls++; Result.success(preview) }, debounceMs = 700))
        composeRule.mainClock.advanceTimeBy(300)
        assertEquals(0, calls)
        composeRule.mainClock.advanceTimeBy(600)
        assertEquals(1, calls)
    }
}
