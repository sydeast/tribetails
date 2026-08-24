package com.tribetails.auntieos.web.ui.settings

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertHasNoClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.screens.settings.ProfileAvatar
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * #518: the avatar/camera-badge used to always render `contentDescription =
 * "Picture upload not available"` while a working "Edit photo" button sat right next
 * to it (SettingsScreen.kt:3659 in the old code) - a screen-reader user was told the
 * feature was unavailable while a sighted one could just click past it. This asserts
 * the accessibility label always matches the real, current state (the "Acceptance"
 * criterion from the issue), and that the badge only claims to be clickable when it
 * genuinely is - happy path (enabled -> tap fires the real upload trigger), in-flight,
 * and the ALWAYS_ON kill-switch's disabled state (defensive; unreachable in prod, see
 * SettingsScreen.kt's module doc, but must still never claim a click will do
 * something it won't).
 */
@OptIn(ExperimentalTestApi::class)
class ProfileAvatarRenderTest {

    @Test
    fun enabledBadgeAdvertisesTheRealUploadAndFiresOnClick() = runDesktopComposeUiTest {
        var uploadCount = 0
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                ProfileAvatar(
                    photoUrl = "",
                    initials = "AB",
                    uploadEnabled = true,
                    uploading = false,
                    onUpload = { uploadCount++ },
                )
            }
        }
        val node = onNodeWithContentDescription("Upload profile photo")
        node.assertIsEnabled()
        node.assertHasClickAction()
        node.performClick()
        assertEquals(1, uploadCount)
    }

    @Test
    fun inFlightBadgeSaysUploadingAndIsNotClickable() = runDesktopComposeUiTest {
        var uploadCount = 0
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                ProfileAvatar(
                    photoUrl = "",
                    initials = "AB",
                    uploadEnabled = true,
                    uploading = true,
                    onUpload = { uploadCount++ },
                )
            }
        }
        val node = onNodeWithContentDescription("Uploading profile photo")
        node.assertIsDisplayed()
        // Not clickable while in flight: a second tap must never double-fire the upload.
        node.assertHasNoClickAction()
        assertEquals(0, uploadCount)
    }

    @Test
    fun disabledBadgeHonestlySaysDisabledInsteadOfClaimingUnavailability() = runDesktopComposeUiTest {
        var uploadCount = 0
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                ProfileAvatar(
                    photoUrl = "",
                    initials = "AB",
                    uploadEnabled = false,
                    uploading = false,
                    onUpload = { uploadCount++ },
                )
            }
        }
        // This state is unreachable in prod (the flag is ALWAYS_ON - see App.kt's
        // FeatureFlags.fromOverrides), but if a caller ever does construct it, the
        // label must describe the real disabled state, never the old flat lie
        // ("Picture upload not available") that ships regardless of what's true - and
        // the badge must not advertise a click it will not honor.
        val node = onNodeWithContentDescription("Profile photo upload disabled")
        node.assertIsDisplayed()
        node.assertHasNoClickAction()
        assertEquals(0, uploadCount)
    }
}
