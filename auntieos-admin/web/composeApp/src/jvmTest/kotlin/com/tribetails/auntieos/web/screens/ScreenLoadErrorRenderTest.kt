package com.tribetails.auntieos.web.screens

import androidx.compose.runtime.Composable
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.data.AuthClient
import com.tribetails.auntieos.web.data.AuthUser
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.screens.directory.KinEditScreen
import com.tribetails.auntieos.web.screens.directory.KinfolkEditScreen
import com.tribetails.auntieos.web.screens.directory.KinfolkProfileScreen
import com.tribetails.auntieos.web.screens.kintales.KinTaleComposeScreen
import com.tribetails.auntieos.web.screens.kintales.KinTaleTemplateEditorScreen
import com.tribetails.auntieos.web.screens.sessions.KinCareDetailScreen
import com.tribetails.auntieos.web.screens.settings.SettingsScreen
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import com.tribetails.auntieos.web.theme.ThemePersonalization
import kotlin.test.AfterTest
import kotlin.test.Test

/**
 * #867: a screen whose record read fails shows the failure instead of a loading
 * shimmer that never ends. With no fixture and no sign-in, every read here fails
 * at the token check, before any request, which is the same path a timeout takes
 * (both end as a FirestoreResult.Error from the polling read).
 */
@OptIn(ExperimentalTestApi::class)
class ScreenLoadErrorRenderTest {

    @AfterTest
    fun tearDown() = JvmFirestoreFixtures.clear()

    private fun ComposeUiTest.showsLoadError(title: String, content: @Composable () -> Unit) {
        setContent { AuntieAppTheme(themeMode = ThemeMode.DARK) { content() } }
        waitUntil(timeoutMillis = 10_000) {
            onAllNodesWithText(title, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() &&
                onAllNodesWithText("Not signed in", substring = true, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
        }
    }

    @Test
    fun editKinfolk() = runDesktopComposeUiTest {
        showsLoadError("Couldn't load this household") {
            KinfolkEditScreen(kinfolkId = "kf1", onBack = {}, onSaved = {}, onArchived = {})
        }
    }

    @Test
    fun editKin() = runDesktopComposeUiTest {
        showsLoadError("Couldn't load this kin") {
            KinEditScreen(kinfolkId = "kf1", kinId = "k1", onBack = {}, onSaved = {}, onArchived = {})
        }
    }

    @Test
    fun kinfolkProfile() = runDesktopComposeUiTest {
        showsLoadError("Couldn't load this household") {
            KinfolkProfileScreen(kinfolkId = "kf1", onBack = {}, onEdit = {}, onAddKin = {}, onViewKin = {})
        }
    }

    @Test
    fun kinCareDetail() = runDesktopComposeUiTest {
        showsLoadError("Couldn't load this Kin Care") {
            KinCareDetailScreen(kinCareId = "s1", onBack = {})
        }
    }

    @Test
    fun kinTaleCompose() = runDesktopComposeUiTest {
        showsLoadError("Couldn't load this Kin Care") {
            KinTaleComposeScreen(sessionId = "s1", onClose = {})
        }
    }

    @Test
    fun kinTaleTemplateEditor() = runDesktopComposeUiTest {
        showsLoadError("Couldn't load templates") {
            KinTaleTemplateEditorScreen(onClose = {})
        }
    }

    @Test
    fun settings() = runDesktopComposeUiTest {
        showsLoadError("Couldn't load business settings") {
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
}
