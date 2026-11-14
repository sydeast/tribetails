package com.tribetails.auntieos.web.screens.settings

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsNodeInteractionsProvider
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.data.AuthClient
import com.tribetails.auntieos.web.data.AuthUser
import com.tribetails.auntieos.web.data.BusinessSettings
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.SettingsChecks
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import com.tribetails.auntieos.web.theme.ThemePersonalization
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertTrue

/**
 * #1593: the Settings panels put the server's sentence beside the field it is
 * about, rendered from a stored document the 2026-11-05 QA walk could produce.
 * The rules themselves are pinned in `SettingsChecksTest`; this pins that the
 * operator sees them, and the Payments Cancel button.
 */
@OptIn(ExperimentalTestApi::class)
class SettingsFieldChecksRenderTest {

    @AfterTest
    fun tearDown() = JvmFirestoreFixtures.clear()

    private fun SemanticsNodeInteractionsProvider.shown(text: String): Boolean =
        onAllNodesWithText(text, substring = true, ignoreCase = true, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()

    private fun ComposeUiTest.openSection(settings: BusinessSettings, section: String, waitFor: String) {
        JvmFirestoreFixtures.businessSettings = settings
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                SettingsScreen(
                    authUser = AuthUser(uid = "u1", email = "e2e-admin@tribetails.com"),
                    auth = AuthClient(),
                    themeMode = ThemeMode.DARK,
                    onThemeModeChange = {},
                    personalization = ThemePersonalization(),
                    onPersonalizationChange = {},
                )
            }
        }
        waitUntil(timeoutMillis = 10_000) { shown(section) }
        onAllNodesWithText(section, useUnmergedTree = true)[0].performClick()
        waitUntil(timeoutMillis = 10_000) { shown(waitFor) }
    }

    @Test
    fun aKinCarePriceThatDoesNotReadSaysSoUnderTheRate() = runDesktopComposeUiTest {
        openSection(
            BusinessSettings(businessName = "Tribe Tails", serviceRates = mapOf("Drop-in" to "abc", "Overnight" to "-5", "Walk" to "")),
            section = "Booking",
            waitFor = "KinCare types",
        )
        assertTrue(shown("Enter the price for \"Drop-in\" in dollars, like 25 or 25.50."))
        assertTrue(shown("The price for \"Overnight\" cannot be negative."))
    }

    @Test
    fun aDayThatClosesBeforeItOpensSaysSoUnderTheDay() = runDesktopComposeUiTest {
        openSection(
            BusinessSettings(businessName = "Tribe Tails", businessHours = mapOf("Monday" to "17:00-09:00", "Tuesday" to "zz-99")),
            section = "Business hours",
            waitFor = "Business hours",
        )
        assertTrue(shown(SettingsChecks.HOURS_CLOSE_BEFORE_OPEN))
        assertTrue(shown(SettingsChecks.HOURS_RANGE_INVALID))
    }

    @Test
    fun aBusinessEmailOrPhoneThatDoesNotReadSaysSo() = runDesktopComposeUiTest {
        openSection(
            BusinessSettings(businessName = "Tribe Tails", businessEmail = "hello@", businessPhone = "555-0142"),
            section = "Business profile",
            waitFor = "Business Email",
        )
        assertTrue(shown(SettingsChecks.EMAIL_INVALID))
        assertTrue(shown(SettingsChecks.PHONE_INVALID))
    }

    @Test
    fun paymentsCancelPutsTheSavedValuesBack() = runDesktopComposeUiTest {
        openSection(
            BusinessSettings(businessName = "Tribe Tails", venmoHandle = "@tribetails"),
            section = "Payments",
            waitFor = "Save payment options",
        )
        // #1966: the Invoices panel above has its own Cancel; this is Payment options' one.
        fun cancel() = onAllNodesWithText("Cancel")[1]
        fun save() = onNodeWithText("Save payment options")
        cancel().assertIsNotEnabled()
        save().assertIsNotEnabled()
        onNodeWithContentDescription("Offer Klarna", useUnmergedTree = true).performSemanticsAction(SemanticsActions.OnClick)
        waitForIdle()
        cancel().assertIsEnabled()
        save().assertIsEnabled()
        cancel().performSemanticsAction(SemanticsActions.OnClick)
        waitForIdle()
        cancel().assertIsNotEnabled()
        save().assertIsNotEnabled()
    }

    @Test
    fun aStoredPaypalLinkInsteadOfANameSaysSo() = runDesktopComposeUiTest {
        openSection(
            BusinessSettings(businessName = "Tribe Tails", paypalHandle = "paypal.me/tribetails"),
            section = "Payments",
            waitFor = "Save payment options",
        )
        assertTrue(shown("Enter the PayPal.Me name: up to 20 letters and numbers."))
    }
}
