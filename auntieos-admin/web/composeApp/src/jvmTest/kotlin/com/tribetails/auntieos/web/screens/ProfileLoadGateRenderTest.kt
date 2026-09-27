package com.tribetails.auntieos.web.screens

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.runDesktopComposeUiTest
import androidx.compose.ui.test.hasSetTextAction
import com.tribetails.auntieos.web.data.AuthClient
import com.tribetails.auntieos.web.data.AuthUser
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.UserProfile
import com.tribetails.auntieos.web.screens.account.AccountSettingsScreen
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import com.tribetails.auntieos.web.ui.components.LOAD_ERROR_RETRY_TAG
import kotlin.test.AfterTest
import kotlin.test.Test

/**
 * #897: on the account screen (the one place the Profile form renders), a failed
 * profile read shows its error with a Retry, and Save Profile stays disabled with
 * the form blank. After Retry loads the profile, Save turns on only once a field
 * is edited.
 */
@OptIn(ExperimentalTestApi::class)
class ProfileLoadGateRenderTest {

    @AfterTest
    fun tearDown() = JvmFirestoreFixtures.clear()

    @Test
    fun aFailedProfileReadDisablesSaveAndRetryRecovers() = runDesktopComposeUiTest {
        // No fixture and no transport: the read fails at the token check.
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                AccountSettingsScreen(
                    authUser = AuthUser(uid = "u1", email = "op@example.com"),
                    auth = AuthClient(),
                    onOpenNotifications = {},
                )
            }
        }
        val title = "Couldn't load your profile"
        waitUntil(timeoutMillis = 10_000) { onAllNodesWithText(title, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        onNode(hasText("Save Profile") and hasClickAction()).assertIsNotEnabled()

        JvmFirestoreFixtures.provideUserProfile = true
        JvmFirestoreFixtures.userProfile = UserProfile(uid = "u1", email = "op@example.com", displayName = "Syd", phone = "555-0100")
        onNodeWithTag(LOAD_ERROR_RETRY_TAG, useUnmergedTree = true).performClick()
        waitUntil(timeoutMillis = 10_000) { onAllNodesWithText(title, useUnmergedTree = true).fetchSemanticsNodes().isEmpty() }
        waitUntil(timeoutMillis = 10_000) { onAllNodesWithText("555-0100", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }

        // Loaded but untouched: nothing to save.
        onNode(hasText("Save Profile") and hasClickAction()).assertIsNotEnabled()
        onNode(hasSetTextAction() and hasText("555-0100")).performTextReplacement("555-0199")
        waitForIdle()
        onNode(hasText("Save Profile") and hasClickAction()).assertIsEnabled()
    }
}
