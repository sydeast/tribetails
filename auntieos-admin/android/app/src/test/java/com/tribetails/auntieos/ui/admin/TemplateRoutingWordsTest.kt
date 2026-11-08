package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.repository.TemplateRepository
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

/**
 * #1592: Template Routing names the notification and the template, never the
 * catalog key or a template id. Same cases as web `templateRoutingFormat.test.ts`
 * and `TemplateAssignments.test.tsx`.
 */
class TemplateRoutingWordsTest {

    private fun row(
        key: String,
        label: String = key,
        source: String = "catalog",
        resolved: String = key,
        hasDefault: Boolean = true,
        bound: Boolean = false,
    ) = TemplateRepository.CatalogKey(
        key = key,
        label = label,
        category = null,
        audience = null,
        source = source,
        defaultTemplateId = key,
        hasDefaultTemplate = hasDefault,
        bound = bound,
        resolvedTemplateId = resolved,
    )

    private fun tpl(id: String, title: String, subject: String = "", headline: String? = null) =
        TemplateRepository.EmailTemplate(
            templateId = id,
            subject = subject,
            body = "",
            html = null,
            title = title,
            description = null,
            tags = emptyList(),
            category = null,
            headline = headline,
        )

    @Test fun `a row is headed by its label, else its key as words`() {
        assertEquals("New invoice", catalogKeyName(row("invoice.new", "New invoice")))
        assertEquals("Invite verify email", catalogKeyName(row("invite.verify-email")))
        assertEquals("Kin removal archived", catalogKeyName(row("kin.removal.archived", "  ")))
    }

    @Test fun `a legacy stray's sentence label is not its name`() {
        assertEquals(
            "Booking confirmed",
            catalogKeyName(row("booking.confirmed", "Not in the catalog, nothing dispatches it", source = "legacy")),
        )
    }

    @Test fun `a key the rows do not hold reads as words`() {
        val rows = listOf(row("invoice.new", "New invoice"))
        assertEquals("New invoice", catalogKeyNameFor("invoice.new", rows))
        assertEquals("Account welcome kinfolk", catalogKeyNameFor("account.welcome.kinfolk", rows))
        assertEquals("Notification", catalogKeyNameFor("", rows))
    }

    @Test fun `an untitled bank doc is named by what it holds, never its id`() {
        assertEquals("Booking confirmed", bankTemplateName(tpl("t1", "Booking confirmed", "x")))
        assertEquals("Your visit", bankTemplateName(tpl("t1", "", "x", headline = "Your visit")))
        assertEquals("Visit booked", bankTemplateName(tpl("t1", " ", "Visit booked")))
        assertEquals("Untitled template", bankTemplateName(tpl("t1", "", "")))
        // listTemplates answers a doc with no title with its id.
        assertEquals("Your invoice", bankTemplateName(tpl("invoice.new", "invoice.new", "Your invoice")))
        assertEquals("Untitled template", bankTemplateName(tpl("invoice.new", "invoice.new", "invoice.new")))
    }

    @Test fun `the routed template is named, never printed as its id`() {
        val names = mapOf("tmpl_ok" to "Booking confirmed")
        assertEquals("Booking confirmed", routedTemplateName("tmpl_ok", names, bankLoaded = true))
        assertEquals("a template not in the bank", routedTemplateName("tmpl_gone", names, bankLoaded = true))
        assertEquals("its template", routedTemplateName("tmpl_gone", names, bankLoaded = false))
        assertEquals(
            "its own template",
            routedTemplateName("invoice.new", names, bankLoaded = true, knownToExist = true),
        )
    }

    @Test fun `the routing row and the editor title carry no key or id`() {
        val r = row("invoice.paid", "Invoice paid", resolved = "tmpl_gone", bound = true)
        val binding = TemplateRepository.TemplateBinding(
            catalogKey = "invoice.paid",
            templateId = "tmpl_gone",
            audience = null,
            triggerKey = "invoice.sent",
            active = true,
        )
        assertEquals("Invoice paid", catalogKeyName(r))
        val subtitle = routingRowSubtitle(r, binding, emptyMap(), bankLoaded = true, missing = false, missingNote = null)
        assertEquals(
            "sends a template not in the bank\noverride, assigned by an admin\nTrigger: Invoice sent",
            subtitle,
        )
        assertEquals("Edit override: Invoice paid", overrideDialogTitle(r))
        assertEquals("Override: New invoice", overrideDialogTitle(row("invoice.new", "New invoice")))
        for (raw in listOf("invoice.paid", "tmpl_gone", "invoice.sent")) {
            assertFalse(subtitle.contains(raw))
            assertFalse(overrideDialogTitle(r).contains(raw))
        }
    }

    @Test fun `a name-matched default the server says exists reads as its own template`() {
        val r = row("invoice.new", "New invoice")
        assertEquals(
            "sends its own template\ndefault, matched by name",
            routingRowSubtitle(r, null, emptyMap(), bankLoaded = true, missing = false, missingNote = null),
        )
    }

    @Test fun `the awaiting-import line names the notifications`() {
        val rows = listOf(row("kin.removal.archived"), row("invoice.paid", "Invoice paid"))
        assertEquals(
            "Not in the bank yet, still delivered: Kin removal archived, Invoice paid. Load them from Template Import.",
            awaitingImportLine(rows),
        )
    }
}
