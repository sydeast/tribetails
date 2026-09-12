package com.tribetails.auntieos.ui.admin

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.model.UserProfile
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The account screen's two panels that touch no repository, plus the hero's
 * pure helpers (#755 sweep, User profile). The hero and the notification
 * switches read `AuntieOSApp.instance.repository`; their logic is in
 * `AccountChannelSwitchTest` and the helpers below.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w1080dp-h4000dp-xhdpi")
class AccountSettingsScreenTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<ComponentActivity>()

    // ── hero helpers ──────────────────────────────────────────────────────────

    @Test
    fun roleLineIsTheTitleThenTheWebRoleLabel() {
        assertEquals("Head of Care · Operator (full admin)", accountRoleLine("Head of Care", sandbox = false))
        assertEquals("Operator (full admin)", accountRoleLine("  ", sandbox = false))
        assertEquals("Test admin (sandbox)", accountRoleLine("", sandbox = true))
    }

    @Test
    fun uidBadgeKeepsTenCharactersThenAnEllipsis() {
        assertEquals("nppJN0a4x2…", accountUidBadge("nppJN0a4x2QRSTUV"))
        assertEquals("short", accountUidBadge("short"))
        assertEquals("exactlyten", accountUidBadge("exactlyten"))
    }

    @Test
    fun initialsTakeTheFirstAndLastWord() {
        assertEquals("AB", accountInitials("Auntie Beasley"))
        assertEquals("AB", accountInitials("Auntie Nora Beasley"))
        assertEquals("A", accountInitials("auntie"))
        assertEquals("?", accountInitials("   "))
    }

    // ── Profile panel ─────────────────────────────────────────────────────────

    @Test
    fun profilePanelLaysTheFieldsOutInTheMockOrderAndEditsThroughTheCallback() {
        var latest: UserProfile? = null
        val profile = UserProfile(uid = "op-1", firstName = "Nora", lastName = "Brooks", displayName = "Auntie Nora")
        composeRule.setContent {
            AuntieOSTheme {
                ProfilePanel(
                    profile = profile,
                    onProfileField = { transform -> latest = transform(profile) },
                )
            }
        }
        composeRule.waitForIdle()

        for (label in listOf("First name", "Last name", "Display name", "Email address", "Phone", "Title / Role", "Bio")) {
            composeRule.onNodeWithContentDescription(label).assertIsDisplayed()
        }
        // The avatar row and the Save button moved into the hero.
        composeRule.onNodeWithText("Change Picture").assertDoesNotExist()
        composeRule.onNodeWithText("Save Profile").assertDoesNotExist()
        composeRule.onNodeWithText("Save profile").assertDoesNotExist()

        composeRule.onNodeWithContentDescription("Title / Role").performTextInput("Owner")
        composeRule.waitForIdle()
        assertEquals("Owner", latest?.title)
        assertEquals("Nora", latest?.firstName)
    }

    // ── Business profile panel ────────────────────────────────────────────────

    @Test
    fun businessProfileSaveWaitsForAnEditThenSavesTheTrimmedCopy() {
        var saved: BusinessSettings? = null
        val settings = BusinessSettings(
            businessName = "Tribe Tails Pet Care",
            businessEmail = "hello@tribetails.com",
            businessPhone = "555-0199",
            businessAddress = "100 Creekside Ln",
            weatherLocation = "Austin, TX",
        )
        composeRule.setContent {
            AuntieOSTheme {
                BusinessProfilePanel(settings = settings, onSave = { saved = it })
            }
        }
        composeRule.waitForIdle()

        for (label in listOf("Business name", "Email", "Phone", "Address", "Weather area")) {
            composeRule.onNodeWithContentDescription(label).assertIsDisplayed()
        }
        // Nothing typed yet, so there is nothing to save.
        composeRule.onNodeWithText("Save").assertIsNotEnabled()
        assertNull(saved)

        composeRule.onNodeWithContentDescription("Phone").performTextInput(" ")
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Save").assertIsEnabled()
        composeRule.onNodeWithText("Save").performClick()
        composeRule.waitForIdle()

        // Trimmed, and every other field carried through unchanged.
        assertEquals("555-0199", saved?.businessPhone)
        assertEquals("Tribe Tails Pet Care", saved?.businessName)
        assertEquals("hello@tribetails.com", saved?.businessEmail)
        assertEquals("100 Creekside Ln", saved?.businessAddress)
        assertEquals("Austin, TX", saved?.weatherLocation)
    }
}
