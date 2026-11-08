package com.tribetails.auntieos.web.screens.admin

import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Column
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.data.CatalogKeyRow
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.TemplateService
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * #1739: the desktop Template Routing is the routing table web and Android show
 * (#382, #384): every notification, what it sends today and why, an Override /
 * Change override action per row, and the notification picked, never typed.
 *
 * Every callable the screen reaches is answered by a fixture, so nothing here
 * touches the network.
 */
@OptIn(ExperimentalTestApi::class)
class TemplateRoutingTableRenderTest {

    @AfterTest
    fun tearDown() {
        JvmFirestoreFixtures.clear()
    }

    /** Two notifications routing by name and one through an override, and one override doc. */
    private fun answers() {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "listTemplateBindings" to """
                {"bindings":[{"catalogKey":"invoice.new","templateId":"tmpl_invoice_v2","audience":"kinfolk","active":true}]}
            """.trimIndent(),
            "listTemplates" to """
                {"templates":[
                  {"templateId":"kincare.booking.confirm","title":"Visit confirmed","subject":"Your visit is booked"},
                  {"templateId":"tmpl_invoice_v2","title":"Invoice, new look","subject":"Your invoice"},
                  {"templateId":"invoice.new","title":"invoice.new","subject":"Your invoice"}
                ]}
            """.trimIndent(),
            "listCatalogKeys" to """
                {"keys":["kincare.booking.confirm","invoice.new","kincare.booking.cancel"],"rows":[
                  {"key":"kincare.booking.confirm","label":"KinCare booking confirmed","source":"catalog",
                   "defaultTemplateId":"kincare.booking.confirm","hasDefaultTemplate":true,"bound":false,
                   "resolvedTemplateId":"kincare.booking.confirm"},
                  {"key":"invoice.new","label":"New invoice or quote issued","source":"catalog",
                   "defaultTemplateId":"invoice.new","hasDefaultTemplate":true,"bound":true,
                   "resolvedTemplateId":"tmpl_invoice_v2"},
                  {"key":"kincare.booking.cancel","label":"KinCare booking canceled","source":"catalog",
                   "defaultTemplateId":"kincare.booking.cancel","hasDefaultTemplate":true,"bound":false,
                   "resolvedTemplateId":"kincare.booking.cancel"}
                ]}
            """.trimIndent(),
        )
    }

    @Test
    fun everyNotificationIsARowWithWhatItSendsAndAnOverrideAction() = runDesktopComposeUiTest {
        answers()
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                Column(Modifier.verticalScroll(rememberScrollState())) { TemplateAssignmentBody(TemplateService()) }
            }
        }
        waitUntil(timeoutMillis = 5_000) { onAllNodesWithText("KinCare booking confirmed").fetchSemanticsNodes().isNotEmpty() }

        // Every notification, overridden or not. The bindings list used to be the
        // whole screen, so the two by-name rows never appeared.
        onNodeWithText("KinCare booking confirmed").assertExists()
        onNodeWithText("New invoice or quote issued").assertExists()
        onNodeWithText("KinCare booking canceled").assertExists()
        onNodeWithText("3 notifications route today. 1 of them through an override, the rest by name.").assertExists()
        // What each sends today, by name, and why.
        onNodeWithText("sends Visit confirmed", substring = true).assertExists()
        onNodeWithText("sends Invoice, new look\noverride, assigned by an admin", substring = true).assertExists()
        // One action per row: Override where it routes by name, Change override where it is bound.
        assertEquals(2, onAllNodesWithText("Override").fetchSemanticsNodes().size)
        assertEquals(1, onAllNodesWithText("Change override").fetchSemanticsNodes().size)
        // The older bindings screen is gone: no typed key, no Add Binding, no "No bindings yet".
        assertEquals(0, onAllNodesWithText("Add Binding").fetchSemanticsNodes().size)
        assertEquals(0, onAllNodesWithText("No bindings yet", substring = true).fetchSemanticsNodes().size)
        assertEquals(0, onAllNodesWithText("kincare.booking.confirm", substring = true).fetchSemanticsNodes().size)
    }

    @Test
    fun theOverrideEditorNamesTheNotificationItWasOpenedFromAndTakesNoTypedKey() = runDesktopComposeUiTest {
        answers()
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                Column(Modifier.verticalScroll(rememberScrollState())) { TemplateAssignmentBody(TemplateService()) }
            }
        }
        waitUntil(timeoutMillis = 5_000) { onAllNodesWithText("Change override").fetchSemanticsNodes().isNotEmpty() }
        onNodeWithText("Change override").performClick()
        waitForIdle()

        onNodeWithText("Change override: New invoice or quote issued").assertExists()
        onNodeWithText("The notification cannot be changed here", substring = true).assertExists()
        assertEquals(0, onAllNodesWithText("Catalog Key").fetchSemanticsNodes().size)
        assertEquals(0, onAllNodesWithText("e.g. kincare.booking.confirm", substring = true).fetchSemanticsNodes().size)
        onNodeWithText("Remove override").assertExists()
    }

    private fun row(key: String, bound: Boolean = false, resolved: String = key) = CatalogKeyRow(
        key = key,
        source = "catalog",
        defaultTemplateId = key,
        hasDefaultTemplate = true,
        bound = bound,
        resolvedTemplateId = resolved,
        label = "",
    )

    @Test
    fun eachRowSaysWhereItsTemplateCameFrom() {
        assertEquals("default, matched by name", routingSource(row("invoice.new")))
        assertEquals("override, assigned by an admin", routingSource(row("invoice.new", bound = true, resolved = "t2")))
        assertEquals(
            "binding is paused, so the name-matched default applies",
            routingSource(row("invoice.new", bound = true)),
        )
        assertEquals("Override", routingActionLabel(row("invoice.new")))
        assertEquals("Change override", routingActionLabel(row("invoice.new", bound = true)))
    }

    @Test
    fun theSearchMatchesTheNameAndTheTemplate() {
        val rows = listOf(row("invoice.new"), row("kincare.booking.confirm", resolved = "t9"))
        assertEquals(listOf("kincare.booking.confirm"), filterRoutingRows(rows, "summer", mapOf("t9" to "Summer visit")).map { it.key })
        assertEquals(listOf("invoice.new"), filterRoutingRows(rows, "Invoice new", emptyMap()).map { it.key })
        assertEquals(rows, filterRoutingRows(rows, "  ", emptyMap()))
    }

    @Test
    fun aMissingTemplateSaysWhatGoesOutInstead() {
        assertEquals(
            "Not in the bank yet, so this sends generic wording that cannot say what happened. Load it from Template Import.",
            missingTemplateNote(row("invoice.new").copy(whenTemplateMissing = "generic", inRepoCorpus = true), templateMissing = true),
        )
        assertNull(missingTemplateNote(row("invoice.new"), templateMissing = false))
    }
}
