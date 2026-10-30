package com.tribetails.auntieos.ui.admin

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextInput
import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.model.PAYMENT_METHOD_CATALOGUE
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * #1177: the admin Android Payment options panel, mounted on a settings
 * document the React admin already wrote switches into.
 *
 * Pins what the operator sees (a switch per method, the web's instructions,
 * a handle box only while its method is on, the blank warning) and what the
 * Save button hands the view model: the web's entries kept, the new one added,
 * the instructions trimmed.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w1080dp-h6000dp-xhdpi")
class PaymentOptionsPanelTest {

    @get:Rule
    val rule = createComposeRule()

    private val webWritten = BusinessSettings(
        venmoHandle = "@tribetails",
        paypalHandle = "paypal.me/tribetails",
        cashappHandle = "\$tribetails",
        paymentOptions = linkedMapOf(
            "zelle" to linkedMapOf("enabled" to true, "instructions" to "Zelle to the business line."),
            "cashapp" to linkedMapOf("enabled" to false, "instructions" to ""),
        ),
    )

    private fun mount(saving: Boolean = false, onSave: (BusinessSettings) -> Unit = {}) {
        rule.setContent {
            AuntieOSTheme {
                PaymentOptionsPanel(settings = webWritten, saving = saving, onSettingsChange = onSave)
            }
        }
    }

    // Field labels render upper-cased (`AuntieField`), so label lookups ignore case.
    private fun shown(text: String): Boolean =
        rule.onAllNodesWithText(text, substring = true, ignoreCase = true, useUnmergedTree = true)
            .fetchSemanticsNodes().isNotEmpty()

    @Test
    fun `every method has a switch and the web's settings open in the form`() {
        mount()
        for (method in PAYMENT_METHOD_CATALOGUE) {
            assertEquals(
                "switch for ${method.label}",
                1,
                rule.onAllNodesWithContentDescription("Offer ${method.label}", useUnmergedTree = true).fetchSemanticsNodes().size,
            )
        }
        assertTrue(shown("Zelle to the business line."))
        assertTrue(shown("Venmo handle"))
        // Cash App is off on the web: its box is hidden, and nothing says "leave it blank to hide".
        assertFalse(shown("Cash App handle"))
        assertFalse(shown("Leave a field blank"))
    }

    @Test
    fun `switching a method on and writing instructions saves the web's shape`() {
        var saved: BusinessSettings? = null
        mount(onSave = { saved = it })

        assertFalse(shown("Write what kinfolk should do"))
        rule.onNodeWithContentDescription("Offer Cash", useUnmergedTree = true)
            .performSemanticsAction(SemanticsActions.OnClick)
        rule.waitForIdle()
        assertTrue("blank warning under an on method with nothing written", shown("Write what kinfolk should do"))

        // The one empty text box on screen is Cash's new instructions box.
        val empty = rule.onAllNodes(hasSetTextAction(), useUnmergedTree = true).fetchSemanticsNodes()
            .indexOfFirst { it.config.getOrNull(SemanticsProperties.EditableText)?.text.isNullOrEmpty() }
        assertTrue(empty >= 0)
        rule.onAllNodes(hasSetTextAction(), useUnmergedTree = true)[empty].performTextInput("  Exact change at pickup.  ")
        rule.waitForIdle()
        assertFalse(shown("Write what kinfolk should do"))

        rule.onNodeWithText("Save payment options").performClick()
        rule.waitForIdle()

        val written = assertNotNullAndGet(saved)
        @Suppress("UNCHECKED_CAST")
        val options = written.paymentOptions as Map<String, Map<String, Any?>>
        assertEquals(mapOf("enabled" to true, "instructions" to "Exact change at pickup."), options["cash"])
        assertEquals(mapOf("enabled" to true, "instructions" to "Zelle to the business line."), options["zelle"])
        assertEquals(false, options["cashapp"]?.get("enabled"))
        assertEquals(PAYMENT_METHOD_CATALOGUE.map { it.id }.toSet(), options.keys)
        // Handles untouched.
        assertEquals("@tribetails", written.venmoHandle)
        assertEquals("\$tribetails", written.cashappHandle)
    }

    @Test
    fun `while a save is in flight the button is a spinner and nothing fires`() {
        var calls = 0
        mount(saving = true, onSave = { calls++ })
        // PrimaryButton swaps its label for a spinner while `loading`.
        assertNull(
            rule.onAllNodesWithText("Save payment options", useUnmergedTree = true).fetchSemanticsNodes().firstOrNull(),
        )
        rule.onNodeWithContentDescription("Offer Cash", useUnmergedTree = true)
            .performSemanticsAction(SemanticsActions.OnClick)
        rule.waitForIdle()
        assertFalse("switches hold still during the save", shown("Write what kinfolk should do"))
        assertEquals(0, calls)
    }

    private fun assertNotNullAndGet(value: BusinessSettings?): BusinessSettings {
        assertNotNull("Save never handed the view model a settings model", value)
        return value!!
    }
}
