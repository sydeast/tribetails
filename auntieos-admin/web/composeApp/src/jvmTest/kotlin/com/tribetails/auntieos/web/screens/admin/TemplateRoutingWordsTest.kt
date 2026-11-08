package com.tribetails.auntieos.web.screens.admin

import com.tribetails.auntieos.web.data.CatalogKeyRow
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.TemplateService
import com.tribetails.auntieos.web.data.WriteResult
import kotlinx.coroutines.runBlocking
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #1592: Template Routing names the notification and the template, never the
 * catalog key, a template id or the database. Same cases as the web
 * `templateRoutingFormat.test.ts` and Android `TemplateRoutingWordsTest`.
 */
class TemplateRoutingWordsTest {

    @AfterTest
    fun tearDown() {
        JvmFirestoreFixtures.callableResponses = emptyMap()
    }

    private fun row(key: String, label: String = key, source: String = "catalog") = CatalogKeyRow(
        key = key,
        source = source,
        defaultTemplateId = key,
        hasDefaultTemplate = true,
        bound = false,
        resolvedTemplateId = key,
        label = label,
    )

    private fun tpl(id: String, title: String, subject: String = "") = TemplateService.EmailTemplate(
        templateId = id,
        subject = subject,
        body = "",
        html = null,
        title = title,
        description = null,
        tags = emptyList(),
        category = null,
    )

    private fun binding(key: String, templateId: String, trigger: String? = null) = TemplateService.TemplateBinding(
        catalogKey = key,
        templateId = templateId,
        audience = null,
        triggerKey = trigger,
        active = true,
    )

    @Test
    fun aKeyIsNamedByItsLabelElseItsKeyAsWords() {
        assertEquals("New invoice", catalogKeyName(row("invoice.new", "New invoice")))
        assertEquals("Invite verify email", catalogKeyName(row("invite.verify-email")))
        assertEquals("Kin removal archived", catalogKeyName(row("kin.removal.archived", "  ")))
        assertEquals(
            "Booking confirmed",
            catalogKeyName(row("booking.confirmed", "Not in the catalog, nothing dispatches it", source = "legacy")),
        )
    }

    @Test
    fun aKeyTheRowsDoNotHoldReadsAsWords() {
        val rows = listOf(row("invoice.new", "New invoice"))
        assertEquals("New invoice", catalogKeyNameFor("invoice.new", rows))
        assertEquals("Account welcome kinfolk", catalogKeyNameFor("account.welcome.kinfolk", rows))
        assertEquals("Notification", catalogKeyNameFor("", rows))
    }

    @Test
    fun anUntitledBankDocIsNamedByWhatItHoldsNeverItsId() {
        assertEquals("Booking confirmed", bankTemplateName(tpl("t1", "Booking confirmed", "x")))
        assertEquals("Visit booked", bankTemplateName(tpl("t1", " ", "Visit booked")))
        assertEquals("Untitled template", bankTemplateName(tpl("t1", "", "")))
        // listTemplates answers a doc with no title with its id.
        assertEquals("Your invoice", bankTemplateName(tpl("invoice.new", "invoice.new", "Your invoice")))
        assertEquals("Untitled template", bankTemplateName(tpl("invoice.new", "invoice.new", "invoice.new")))
    }

    @Test
    fun theBoundTemplateIsNamedNeverPrintedAsItsId() {
        val names = mapOf("tmpl_ok" to "Booking confirmed")
        assertEquals("Booking confirmed", routedTemplateName("tmpl_ok", names, bankLoaded = true))
        assertEquals("a template not in the bank", routedTemplateName("tmpl_gone", names, bankLoaded = true))
        assertEquals("its template", routedTemplateName("tmpl_gone", names, bankLoaded = false))
    }

    @Test
    fun theTriggerAndTheEditorTitleCarryNoKey() {
        val r = row("invoice.paid", "Invoice paid")
        val subtitle = routingRowSubtitle(
            row = r,
            binding = binding("invoice.paid", "t", trigger = "invoice.sent"),
            namesById = emptyMap(),
            bankLoaded = false,
            missing = false,
            missingNote = null,
        )
        assertTrue(subtitle.contains("Trigger: Invoice sent"))
        val plain = routingRowSubtitle(r, binding("invoice.paid", "t", trigger = "invoice.paid"), emptyMap(), false, false, null)
        assertFalse(plain.contains("Trigger"))
        assertEquals("Override: Invoice paid", overrideDialogTitle(r))
        assertEquals("Change override: Invoice paid", overrideDialogTitle(r.copy(bound = true)))
        assertFalse(OVERRIDE_DIALOG_HINT.contains("Firestore"))
    }
    @Test
    fun theBannersNameTheNotifications() {
        val rows = listOf(row("invite.verify-email"), row("invoice.paid", "Invoice paid"))
        assertEquals(
            "The template does not exist: Invite verify email, Invoice paid. The repo has a copy of Invoice paid. " +
                "Load it from Template Import.",
            failingKeysLine(listOf("invite.verify-email", "invoice.paid"), listOf("invoice.paid"), rows),
        )
        assertEquals(
            "Invoice paid. Load them from Template Import.",
            awaitingImportLine(listOf("invoice.paid"), rows),
        )
    }

    @Test
    fun theRowDecodeKeepsTheCatalogLabel() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "listCatalogKeys" to """
                {"keys":["invoice.new","old.row"],"rows":[
                  {"key":"invoice.new","label":"New invoice","source":"catalog","defaultTemplateId":"invoice.new",
                   "hasDefaultTemplate":true,"bound":false,"resolvedTemplateId":"invoice.new"},
                  {"key":"old.row","source":"direct-send","hasDefaultTemplate":false}
                ]}
            """.trimIndent(),
        )
        val r = TemplateService().listCatalogKeyRows()
        assertTrue(r is WriteResult.Ok)
        val rows = (r as WriteResult.Ok).value
        assertEquals("New invoice", rows[0].label)
        assertEquals("", rows[1].label)
        assertEquals("Old row", catalogKeyName(rows[1]))
    }
}
