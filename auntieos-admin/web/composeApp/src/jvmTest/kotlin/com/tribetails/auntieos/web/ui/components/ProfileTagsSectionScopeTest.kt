package com.tribetails.auntieos.web.ui.components

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.observability.errorSink
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * #898: [ProfileTagsSection] launched its saves on `rememberCoroutineScope()`,
 * which has no uncaught-exception handler. A `require` failure in
 * FirestoreClient (updateKinfolkTags/updateKinTags, ~665/671) reached the
 * coroutine's default handler, which on desktop can take the whole window down
 * instead of reporting and letting the revert-with-message the panel is built
 * around actually run.
 *
 * This proves the fix behaviorally: an [onSaveTags] that throws (not merely
 * returns [WriteResult.Err]) is caught and reported, and the test, standing in
 * for the desktop process, completes normally rather than propagating.
 */
@OptIn(ExperimentalTestApi::class)
class ProfileTagsSectionScopeTest {

    private val defaultErrorSink = errorSink

    @AfterTest
    fun tearDown() {
        errorSink = defaultErrorSink
    }

    @Test
    fun aThrowingSaveIsReportedInsteadOfCrashingTheProcess() = runDesktopComposeUiTest {
        val reported = mutableListOf<Throwable>()
        errorSink = { t, _ -> reported += t }

        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                ProfileTagsSection(
                    scope = TagScope.PET,
                    initialTags = listOf("vip"),
                    client = FirestoreClient(),
                    onSaveTags = { throw IllegalArgumentException("require failed: not owned by this operator") },
                )
            }
        }

        onNodeWithContentDescription("Remove vip tag", useUnmergedTree = true).performClick()

        waitUntil(timeoutMillis = 10_000) { reported.isNotEmpty() }
        assertEquals(1, reported.size)
        assertTrue(reported.single() is IllegalArgumentException)
        assertEquals("require failed: not owned by this operator", reported.single().message)
    }
}
