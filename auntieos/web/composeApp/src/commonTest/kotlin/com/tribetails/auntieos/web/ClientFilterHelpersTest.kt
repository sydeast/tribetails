package com.tribetails.auntieos.web

import com.tribetails.auntieos.web.data.Payment
import com.tribetails.auntieos.web.data.TemplateService
import com.tribetails.auntieos.web.data.TrainingDocument
import com.tribetails.auntieos.web.screens.admin.genuineTriggerOverride
import com.tribetails.auntieos.web.screens.admin.templateBankSearchFilter
import com.tribetails.auntieos.web.screens.payments.PaymentMethodFilter
import com.tribetails.auntieos.web.screens.payments.paymentsSearchFilter
import com.tribetails.auntieos.web.screens.trainingdocs.trainingDocsCommTypeFilter
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * Pure-helper coverage for the client-side filters/echoes wired into the web admin
 * + payments screens. Mirrors the Android ClientFilterHelpersTest: each helper only
 * narrows the already-loaded list / echoes only a genuine override; no server search
 * exists.
 */
class ClientFilterHelpersTest {

    // ── Payments search + method filter ──────────────────────────────────────
    private fun pay(
        kinfolkName: String = "",
        client: String = "",
        method: String = "",
        ref: String = "",
        notes: String = "",
    ) = Payment(
        kinfolkName = kinfolkName,
        client = client,
        paymentMethod = method,
        referenceNumber = ref,
        notes = notes,
    )

    private val payments = listOf(
        pay(kinfolkName = "Alice Smith", method = "CASH", ref = "A-100", notes = "first visit"),
        pay(kinfolkName = "Bob Jones", method = "CHECK", ref = "B-200", notes = "monthly"),
        pay(kinfolkName = "Carol Lee", method = "CASH", ref = "C-300", notes = "tip included"),
    )

    @Test
    fun payments_emptyQueryAllMethodReturnsAll() {
        assertEquals(payments, paymentsSearchFilter(payments, "", PaymentMethodFilter.All))
        assertEquals(payments, paymentsSearchFilter(payments, "   ", PaymentMethodFilter.All))
    }

    @Test
    fun payments_queryMatchesAnySearchableFieldCaseInsensitive() {
        assertEquals(listOf(payments[0]), paymentsSearchFilter(payments, "ALICE", PaymentMethodFilter.All))
        assertEquals(listOf(payments[1]), paymentsSearchFilter(payments, "b-200", PaymentMethodFilter.All))
        assertEquals(listOf(payments[2]), paymentsSearchFilter(payments, "tip included", PaymentMethodFilter.All))
    }

    @Test
    fun payments_methodFilterNarrowsByMethod() {
        assertEquals(
            listOf(payments[0], payments[2]),
            paymentsSearchFilter(payments, "", PaymentMethodFilter.Cash),
        )
        assertEquals(listOf(payments[1]), paymentsSearchFilter(payments, "", PaymentMethodFilter.Check))
        assertEquals(emptyList(), paymentsSearchFilter(payments, "", PaymentMethodFilter.Card))
    }

    @Test
    fun payments_combinedQueryAndMethod() {
        // Cash + "carol" -> only Carol Lee.
        assertEquals(listOf(payments[2]), paymentsSearchFilter(payments, "carol", PaymentMethodFilter.Cash))
        // Check + "alice" -> no overlap (Alice is cash).
        assertEquals(emptyList(), paymentsSearchFilter(payments, "alice", PaymentMethodFilter.Check))
    }

    // ── Template Bank search ─────────────────────────────────────────────────
    private fun tpl(id: String, title: String) = TemplateService.EmailTemplate(
        templateId = id, subject = "", body = "", html = null,
        title = title, description = null, tags = emptyList(), category = null,
    )

    private val templates = listOf(
        tpl("booking.confirmed", "Booking confirmed"),
        tpl("invoice.sent", "Invoice is ready"),
        tpl("kintale.ready", "Your KinTale"),
    )

    @Test
    fun templateBank_blankQueryReturnsAll() {
        assertEquals(templates, templateBankSearchFilter(templates, "   "))
    }

    @Test
    fun templateBank_matchesTitleAndKeyCaseInsensitive() {
        assertEquals(listOf(templates[0]), templateBankSearchFilter(templates, "BOOKING"))
        assertEquals(listOf(templates[1]), templateBankSearchFilter(templates, "invoice"))
        assertEquals(listOf(templates[2]), templateBankSearchFilter(templates, "kintale"))
    }

    @Test
    fun templateBank_nonMatchIsEmpty() {
        assertEquals(emptyList(), templateBankSearchFilter(templates, "zzz-nope"))
    }

    // ── Training docs comm-type filter ───────────────────────────────────────
    private val docs = listOf(
        TrainingDocument(_id = "a", title = "A", communicationType = "Email"),
        TrainingDocument(_id = "b", title = "B", communicationType = "SMS"),
        TrainingDocument(_id = "c", title = "C", communicationType = "Email"),
    )

    @Test
    fun trainingDocs_nullSelectionReturnsAll() {
        assertEquals(docs, trainingDocsCommTypeFilter(docs, null))
    }

    @Test
    fun trainingDocs_keepsOnlyExactCommType() {
        assertEquals(listOf(docs[0], docs[2]), trainingDocsCommTypeFilter(docs, "Email"))
        assertEquals(listOf(docs[1]), trainingDocsCommTypeFilter(docs, "SMS"))
    }

    @Test
    fun trainingDocs_unknownCommTypeIsEmpty() {
        assertEquals(emptyList(), trainingDocsCommTypeFilter(docs, "Push"))
    }

    // ── Template assignment trigger-override echo ────────────────────────────
    @Test
    fun triggerOverride_nullWhenBlankOrAbsent() {
        assertNull(genuineTriggerOverride(null, "booking.confirmed"))
        assertNull(genuineTriggerOverride("", "booking.confirmed"))
        assertNull(genuineTriggerOverride("   ", "booking.confirmed"))
    }

    @Test
    fun triggerOverride_nullWhenEqualsCatalogKey() {
        // Server defaults a blank triggerKey to the catalogKey; that is not an override.
        assertNull(genuineTriggerOverride("booking.confirmed", "booking.confirmed"))
    }

    @Test
    fun triggerOverride_returnsGenuineOverride() {
        assertEquals("custom.trigger", genuineTriggerOverride("custom.trigger", "booking.confirmed"))
    }
}
