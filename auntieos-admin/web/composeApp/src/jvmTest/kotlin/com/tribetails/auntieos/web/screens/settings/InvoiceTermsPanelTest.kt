package com.tribetails.auntieos.web.screens.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.FakeAuntieDataSource
import com.tribetails.auntieos.web.data.BusinessSettings
import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.businessSettingsChangedFields
import com.tribetails.auntieos.web.screens.invoices.InvoiceTermsCode
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * #1966: Settings > Invoices > Payment terms on the desktop console. Starts on
 * due on receipt, offers the ruled options, saves only its field, and a refused
 * save changes nothing.
 */
@OptIn(ExperimentalTestApi::class)
class InvoiceTermsPanelTest {

    private fun ComposeUiTest.show(loaded: BusinessSettings, saveFails: Boolean = false): FakeAuntieDataSource {
        val fake = FakeAuntieDataSource(saveShouldFail = saveFails, saveFailMessage = "Pick payment terms from the list.")
        fake.emitBusinessSettings(FirestoreResult.Data(loaded))
        val vm = SettingsViewModel(fake)
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                Column(Modifier.verticalScroll(rememberScrollState())) {
                    InvoiceTermsPanel(settingsData = loaded, settingsLoaded = true, save = { vm.saveSettings(it) })
                }
            }
        }
        waitUntil(timeoutMillis = 10_000) { onAllNodesWithText("PAYMENT TERMS").fetchSemanticsNodes().isNotEmpty() }
        return fake
    }

    private fun ComposeUiTest.pick(current: String, next: String) {
        onNodeWithText(current).performScrollTo().performClick()
        waitForIdle()
        onNodeWithText(next).performClick()
        waitForIdle()
    }

    @Test
    fun aBusinessThatNeverChoseStartsOnDueOnReceipt() = runDesktopComposeUiTest {
        assertEquals("due_on_receipt", BusinessSettings().invoicePaymentTerms)
        show(BusinessSettings())
        onNodeWithText("Invoices").assertExists()
        onNodeWithText("Due on receipt").assertExists()
        onNodeWithText("Save payment terms").assertIsNotEnabled()
    }

    @Test
    fun pickingTermsAndSavingSavesThem() = runDesktopComposeUiTest {
        val loaded = BusinessSettings(businessName = "Tribe Tails")
        val fake = show(loaded)
        pick("Due on receipt", "Due 14 days after the last visit")
        onNodeWithText("Save payment terms").performScrollTo().performClick()
        waitUntil(timeoutMillis = 10_000) { fake.lastSavedBusinessSettings != null }
        assertEquals(loaded.copy(invoicePaymentTerms = "net_14_after_last_visit"), fake.lastSavedBusinessSettings)
    }

    @Test
    fun theListLeavesOutThePerInvoiceChoices() = runDesktopComposeUiTest {
        show(BusinessSettings())
        onNodeWithText("Due on receipt").performScrollTo().performClick()
        waitForIdle()
        onNodeWithText("Due 30 days before the first visit").assertExists()
        assertEquals(0, onAllNodesWithText("A date I pick myself").fetchSemanticsNodes().size)
        assertEquals(0, onAllNodesWithText("Due 14 days after the invoice date").fetchSemanticsNodes().size)
    }

    @Test
    fun aStoredSettingReadsBack() = runDesktopComposeUiTest {
        show(BusinessSettings(invoicePaymentTerms = "net_7_before_first_visit"))
        onNodeWithText("Due 7 days before the first visit").assertExists()
    }

    @Test
    fun aRefusedSaveSavesNothing() = runDesktopComposeUiTest {
        val fake = show(BusinessSettings(), saveFails = true)
        pick("Due on receipt", "Due on the day of the first visit")
        onNodeWithText("Save payment terms").performScrollTo().performClick()
        waitForIdle()
        assertNull(fake.lastSavedBusinessSettings)
    }

    @Test
    fun theSaveSendsOnlyThePaymentTermsField() {
        val loaded = BusinessSettings(businessName = "Tribe Tails")
        val codec = Json { encodeDefaults = true }
        assertEquals(
            mapOf("invoicePaymentTerms" to JsonPrimitive("due_on_first_visit")),
            businessSettingsChangedFields(loaded, loaded.withPaymentTerms(InvoiceTermsCode.DUE_ON_FIRST_VISIT), codec),
        )
        assertEquals(emptyMap(), businessSettingsChangedFields(loaded, loaded.copy(), codec))
    }
}
