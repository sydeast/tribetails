package com.tribetails.auntieos.ui.admin

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.model.businessSettingsFieldChanges
import com.tribetails.auntieos.domain.InvoiceTermsCode
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * #1966: Settings > Invoices > Payment terms on Android. Starts on due on
 * receipt, offers the ruled options, and saves only its one field.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w1080dp-h4000dp-xhdpi")
class InvoiceTermsPanelTest {

    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    private val loaded = BusinessSettings(businessName = "Tribe Tails", timeZone = "America/Chicago")

    private fun mount(settings: BusinessSettings, onChange: (BusinessSettings) -> Unit = {}) {
        rule.setContent {
            AuntieOSTheme {
                InvoiceTermsPanel(settings = settings, saving = false, onSettingsChange = onChange)
            }
        }
        rule.waitForIdle()
    }

    @Test
    fun `a business that never chose starts on due on receipt`() {
        assertEquals("due_on_receipt", BusinessSettings().invoicePaymentTerms)
        mount(loaded)
        rule.onNodeWithText("Invoices").assertExists()
        rule.onNodeWithText("Due on receipt").assertExists()
        rule.onNodeWithText("Save payment terms").assertIsNotEnabled()
    }

    @Test
    fun `picking terms and saving hands back only that change`() {
        var saved: BusinessSettings? = null
        mount(loaded) { saved = it }
        rule.onNodeWithText("Due on receipt").performClick()
        rule.waitForIdle()
        rule.onNodeWithText("Due 30 days before the first visit").assertExists()
        rule.onNodeWithText("Due 14 days after the last visit").performClick()
        rule.waitForIdle()
        rule.onNodeWithText("Save payment terms").assertIsEnabled().performClick()
        rule.waitForIdle()
        val edited = requireNotNull(saved)
        assertEquals(
            mapOf<String, Any?>("invoicePaymentTerms" to "net_14_after_last_visit"),
            businessSettingsFieldChanges(loaded, edited),
        )
    }

    @Test
    fun `the setting list leaves out the per-invoice choices`() {
        mount(loaded)
        rule.onNodeWithText("Due on receipt").performClick()
        rule.waitForIdle()
        rule.onNodeWithText("A date I pick myself").assertDoesNotExist()
        rule.onNodeWithText("Due 14 days after the invoice date").assertDoesNotExist()
    }

    @Test
    fun `a stored setting reads back, and a value off the list reads as due on receipt`() {
        mount(loaded.copy(invoicePaymentTerms = "net_7_before_first_visit"))
        rule.onNodeWithText("Due 7 days before the first visit").assertExists()
    }

    @Test
    fun `an untouched panel writes nothing`() {
        assertNull(businessSettingsFieldChanges(loaded, loaded.copy())["invoicePaymentTerms"])
        assertEquals(
            mapOf<String, Any?>("invoicePaymentTerms" to "due_on_first_visit"),
            businessSettingsFieldChanges(loaded, loaded.withPaymentTerms(InvoiceTermsCode.DUE_ON_FIRST_VISIT)),
        )
    }
}
