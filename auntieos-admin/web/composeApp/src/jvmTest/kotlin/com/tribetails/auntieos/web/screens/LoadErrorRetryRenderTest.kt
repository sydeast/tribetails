package com.tribetails.auntieos.web.screens

import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.data.AuthClient
import com.tribetails.auntieos.web.data.AuthUser
import com.tribetails.auntieos.web.data.BusinessSettings
import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.Kin
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.data.Kinfolk
import com.tribetails.auntieos.web.screens.directory.KinEditScreen
import com.tribetails.auntieos.web.screens.directory.KinfolkEditScreen
import com.tribetails.auntieos.web.screens.directory.KinfolkProfileScreen
import com.tribetails.auntieos.web.screens.kintales.KinTaleComposeScreen
import com.tribetails.auntieos.web.screens.sessions.KinCareDetailScreen
import com.tribetails.auntieos.web.screens.settings.SettingsScreen
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import com.tribetails.auntieos.web.theme.ThemePersonalization
import com.tribetails.auntieos.web.ui.components.LOAD_ERROR_RETRY_TAG
import com.tribetails.auntieos.web.ui.components.LoadErrorBanner
import com.tribetails.auntieos.web.ui.components.rememberReloadableRead
import com.tribetails.auntieos.web.ui.components.settlesRetry
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.flow
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * #867 review: a load error banner's Retry reads again now. Each screen test opens
 * with no fixture (the read fails at the token check and the banner shows), then
 * supplies the record and presses Retry. The banner can only go away if Retry
 * built a fresh stream, because the failed one never looks at a fixture again.
 */
@OptIn(ExperimentalTestApi::class)
class LoadErrorRetryRenderTest {

    @AfterTest
    fun tearDown() = JvmFirestoreFixtures.clear()

    private fun ComposeUiTest.retryRecovers(title: String, supply: () -> Unit, content: @Composable () -> Unit) {
        setContent { AuntieAppTheme(themeMode = ThemeMode.DARK) { content() } }
        waitUntil(timeoutMillis = 10_000) { onAllNodesWithText(title, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        supply()
        onNodeWithTag(LOAD_ERROR_RETRY_TAG, useUnmergedTree = true).performClick()
        waitUntil(timeoutMillis = 10_000) { onAllNodesWithText(title, useUnmergedTree = true).fetchSemanticsNodes().isEmpty() }
    }

    @Test
    fun editKin() = runDesktopComposeUiTest {
        retryRecovers("Couldn't load this kin", { JvmFirestoreFixtures.kinByKinfolk = mapOf("kf1" to listOf(Kin(_id = "k1", kinfolkId = "kf1", name = "Biscuit"))) }) {
            KinEditScreen(kinfolkId = "kf1", kinId = "k1", onBack = {}, onSaved = {}, onArchived = {})
        }
    }

    @Test
    fun editKinfolk() = runDesktopComposeUiTest {
        retryRecovers("Couldn't load this household", { JvmFirestoreFixtures.kinfolk = listOf(Kinfolk(_id = "kf1")) }) {
            KinfolkEditScreen(kinfolkId = "kf1", onBack = {}, onSaved = {}, onArchived = {})
        }
    }

    @Test
    fun kinfolkProfile() = runDesktopComposeUiTest {
        retryRecovers("Couldn't load this household", { JvmFirestoreFixtures.kinfolk = listOf(Kinfolk(_id = "kf1")) }) {
            KinfolkProfileScreen(kinfolkId = "kf1", onBack = {}, onEdit = {}, onAddKin = {}, onViewKin = {})
        }
    }

    @Test
    fun kinCareDetail() = runDesktopComposeUiTest {
        retryRecovers("Couldn't load this Kin Care", { JvmFirestoreFixtures.sessions = listOf(KinCareSession(_id = "s1")) }) {
            KinCareDetailScreen(kinCareId = "s1", onBack = {})
        }
    }

    @Test
    fun kinTaleCompose() = runDesktopComposeUiTest {
        retryRecovers("Couldn't load this Kin Care", { JvmFirestoreFixtures.sessions = listOf(KinCareSession(_id = "s1")) }) {
            KinTaleComposeScreen(sessionId = "s1", onClose = {})
        }
    }

    @Test
    fun settings() = runDesktopComposeUiTest {
        retryRecovers("Couldn't load business settings", { JvmFirestoreFixtures.businessSettings = BusinessSettings() }) {
            SettingsScreen(
                authUser = AuthUser(uid = "u1", email = "op@example.com"),
                auth = AuthClient(),
                themeMode = ThemeMode.DARK,
                onThemeModeChange = {},
                personalization = ThemePersonalization(),
                onPersonalizationChange = {},
            )
        }
    }

    /** Retry fetches again, and the button shows a spinner and "Retrying" until that fetch answers. */
    @Test
    fun retryFetchesAgainAndShowsItIsWorkingUntilTheAnswerArrives() = runDesktopComposeUiTest {
        val fetches = AtomicInteger(0)
        val secondAnswer = CompletableDeferred<Unit>()
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                val reload = rememberReloadableRead()
                val state by remember(reload.generation) {
                    flow {
                        if (fetches.incrementAndGet() > 1) secondAnswer.await()
                        emit(FirestoreResult.Error("Timed out") as FirestoreResult<Unit>)
                    }.settlesRetry(reload)
                }.collectAsState(initial = FirestoreResult.Loading)
                (state as? FirestoreResult.Error)?.let {
                    LoadErrorBanner("Couldn't load", it.message, onRetry = reload::retry, retrying = reload.retrying)
                }
            }
        }
        waitUntil(timeoutMillis = 10_000) { onAllNodesWithText("Retry", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        assertEquals(1, fetches.get())

        onNodeWithTag(LOAD_ERROR_RETRY_TAG, useUnmergedTree = true).performClick()
        waitUntil(timeoutMillis = 10_000) { onAllNodesWithText("Retrying", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        assertEquals(2, fetches.get())

        secondAnswer.complete(Unit)
        waitUntil(timeoutMillis = 10_000) { onAllNodesWithText("Retry", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
    }
}
