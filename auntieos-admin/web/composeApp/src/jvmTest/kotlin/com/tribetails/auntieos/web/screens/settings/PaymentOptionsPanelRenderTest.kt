package com.tribetails.auntieos.web.screens.settings

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsNodeInteractionsProvider
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.data.AuthClient
import com.tribetails.auntieos.web.data.AuthUser
import com.tribetails.auntieos.web.data.BusinessSettings
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.PAYMENT_METHOD_CATALOGUE
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import com.tribetails.auntieos.web.theme.ThemePersonalization
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * #1177: the desktop Payment options panel, rendered from a settings document
 * the React admin already wrote switches into.
 *
 * The write side (what a save sends, and that it keeps the web's entries) is
 * pinned in `PaymentMethodsTest`. This pins what the operator sees: a switch for
 * each of the eleven methods, the web's instructions in Zelle's box, a handle
 * box only while its method is on, and the blank warning the moment an
 * instructions method is switched on with nothing written.
 */
@OptIn(ExperimentalTestApi::class)
class PaymentOptionsPanelRenderTest {

    @AfterTest
    fun tearDown() = JvmFirestoreFixtures.clear()

    private val webWritten = BusinessSettings(
        venmoHandle = "@tribetails",
        cashappHandle = "\$tribetails",
        paymentOptions = buildJsonObject {
            putJsonObject("zelle") {
                put("enabled", true)
                put("instructions", "Zelle to the business line, invoice number in the note.")
            }
            putJsonObject("cashapp") {
                put("enabled", false)
                put("instructions", "")
            }
        },
    )

    // Field labels render upper-cased (`BottomBorderField`), so text lookups ignore case.
    private fun SemanticsNodeInteractionsProvider.shown(text: String): Boolean =
        onAllNodesWithText(text, substring = true, ignoreCase = true, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()

    @Test
    fun theElevenMethodsRenderWithTheWebsSwitchesAndInstructions() = runDesktopComposeUiTest {
        JvmFirestoreFixtures.businessSettings = webWritten
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
        waitUntil(timeoutMillis = 10_000) { shown("Payments") }
        onAllNodesWithText("Payments", useUnmergedTree = true)[0].performClick()
        waitUntil(timeoutMillis = 10_000) { shown("Save payment options") }

        // One switch per method, labelled the way the web labels them.
        for (method in PAYMENT_METHOD_CATALOGUE) {
            val nodes = onAllNodesWithContentDescription("Offer ${method.label}", useUnmergedTree = true).fetchSemanticsNodes()
            assertEquals(1, nodes.size, "switch for ${method.label}")
        }

        // The web's Zelle instructions open in the box; Venmo is on (by default) with its handle.
        assertTrue(shown("Zelle to the business line, invoice number in the note."), "Zelle instructions")
        assertTrue(shown("Venmo handle"), "Venmo handle box")
        // Cash App is switched off on the web, so its handle box is hidden, not cleared.
        assertTrue(!shown("Cash App handle"), "Cash App handle box hidden while off")

        // Switching Cash on with nothing written adds a second instructions box
        // (Zelle's is the first) and the warning under it.
        fun boxes() = onAllNodesWithText("What kinfolk should do", ignoreCase = true, useUnmergedTree = true).fetchSemanticsNodes().size
        assertEquals(1, boxes(), "only Zelle's box before the switch")
        assertTrue(!shown("Write what kinfolk should do"), "no warning before the switch")
        // The row sits below the fold in the test window, so the click goes through
        // the switch's own OnClick action rather than a pointer at its coordinates.
        onNodeWithContentDescription("Offer Cash", useUnmergedTree = true).performSemanticsAction(SemanticsActions.OnClick)
        waitUntil(timeoutMillis = 5_000) { shown("Write what kinfolk should do") }
        assertEquals(2, boxes(), "Cash's box appears with its switch")
    }
}
