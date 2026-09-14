// GENERATED FILE. DO NOT EDIT.
//
// The Contracts module (CONTEXT.md), generated from the server zod schemas
// under ADR-0001 decision 2. The schema is the authority for both directions;
// this file is a projection of it and any hand edit is lost on the next run.
//
// Source:      mytribe/functions/src/{admin,portal}/*.ts (zod Args + Result)
// Regenerate:  npm --prefix mytribe/functions run contracts:generate
// Verify:      npm --prefix mytribe/functions run contracts:check
//
// CI runs the verify command and fails on any difference, so a schema change
// and its generated fallout land in one reviewable commit.

@file:Suppress("UNCHECKED_CAST")

package com.tribetails.auntieos.data.contracts

/**
 * A nested payload object, or null when the wire value is not a map.
 *
 * The cast is unchecked because a JSON map arrives as `Map<*, *>` with no element
 * types; every value read out of it is re-checked one field at a time below.
 */
private fun contractRawMap(value: Any?): Map<String, Any?>? = value as? Map<String, Any?>

// ---------- Types shared by more than one callable ----------

/** `InvoiceLineItemDto`, shared across callables. */
data class InvoiceLineItemDto(
    val lineId: String,
    /** One of `stored`, `session`. `""` when the payload omits it. */
    val source: String,
    val sessionId: String,
    val label: String,
    val dateIso: String?,
    val amountCents: Long?,
    val qty: Double?,
    val unitCents: Long?,
)

/**
 * Fail-soft decode of `InvoiceLineItemDto` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeInvoiceLineItemDto(raw: Map<String, Any?>?): InvoiceLineItemDto =
    InvoiceLineItemDto(
        lineId = (raw?.get("lineId") as? String).orEmpty(),
        source = (raw?.get("source") as? String).orEmpty(),
        sessionId = (raw?.get("sessionId") as? String).orEmpty(),
        label = (raw?.get("label") as? String).orEmpty(),
        dateIso = raw?.get("dateIso") as? String,
        amountCents = (raw?.get("amountCents") as? Number)?.toLong(),
        qty = (raw?.get("qty") as? Number)?.toDouble(),
        unitCents = (raw?.get("unitCents") as? Number)?.toLong(),
    )

/** `InvoiceDtoPayMethod`, shared across callables. */
data class InvoiceDtoPayMethod(
    /** One of `stripe`, `venmo`, `paypal`, `cashapp`, `zelle`, `cash`, `check`, `banktransfer`, `klarna`, `affirm`, `other`. `""` when the payload omits it. */
    val id: String,
    val label: String,
    /** One of `checkout`, `link`, `instructions`. `""` when the payload omits it. */
    val kind: String,
    val url: String?,
    val instructions: String?,
)

/**
 * Fail-soft decode of `InvoiceDtoPayMethod` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeInvoiceDtoPayMethod(raw: Map<String, Any?>?): InvoiceDtoPayMethod =
    InvoiceDtoPayMethod(
        id = (raw?.get("id") as? String).orEmpty(),
        label = (raw?.get("label") as? String).orEmpty(),
        kind = (raw?.get("kind") as? String).orEmpty(),
        url = raw?.get("url") as? String,
        instructions = raw?.get("instructions") as? String,
    )

/** `InvoiceDto`, shared across callables. */
data class InvoiceDto(
    val id: String,
    val kinfolkId: String,
    val kinfolkName: String?,
    val client: String?,
    val total: Double,
    val amountDue: Double,
    val isPaid: Boolean,
    /** One of `quote`, `draft`, `cancelled`, `credit`, `redeemed`, `paid`, `zero`, `open`. `""` when the payload omits it. */
    val status: String,
    /** One of `all`, `metadataOnly`, `none`, or null when the payload omits it. */
    val editScope: String?,
    val paidCents: Long,
    val partiallyPaid: Boolean,
    val date: String?,
    val dueDate: String?,
    val discount: String?,
    val terms: String?,
    val paymentsHistory: String?,
    val address: String?,
    val viewed: Boolean,
    /** One of `accepted`, `denied`, or null when the payload omits it. */
    val quoteDecision: String?,
    val quoteDecidedAtMs: Double?,
    val creditAmountCents: Long?,
    /** Always `accountBalance` on the wire. */
    val creditTarget: String?,
    val creditRedeemedAtMs: Double?,
    /** Null when the payload omits the key. */
    val lineItems: List<InvoiceLineItemDto>? = null,
    val payMethods: List<InvoiceDtoPayMethod>,
)

/**
 * Fail-soft decode of `InvoiceDto` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeInvoiceDto(raw: Map<String, Any?>?): InvoiceDto =
    InvoiceDto(
        id = (raw?.get("id") as? String).orEmpty(),
        kinfolkId = (raw?.get("kinfolkId") as? String).orEmpty(),
        kinfolkName = raw?.get("kinfolkName") as? String,
        client = raw?.get("client") as? String,
        total = (raw?.get("total") as? Number)?.toDouble() ?: 0.0,
        amountDue = (raw?.get("amountDue") as? Number)?.toDouble() ?: 0.0,
        isPaid = raw?.get("isPaid") as? Boolean ?: false,
        status = (raw?.get("status") as? String).orEmpty(),
        editScope = raw?.get("editScope") as? String,
        paidCents = (raw?.get("paidCents") as? Number)?.toLong() ?: 0L,
        partiallyPaid = raw?.get("partiallyPaid") as? Boolean ?: false,
        date = raw?.get("date") as? String,
        dueDate = raw?.get("dueDate") as? String,
        discount = raw?.get("discount") as? String,
        terms = raw?.get("terms") as? String,
        paymentsHistory = raw?.get("paymentsHistory") as? String,
        address = raw?.get("address") as? String,
        viewed = raw?.get("viewed") as? Boolean ?: false,
        quoteDecision = raw?.get("quoteDecision") as? String,
        quoteDecidedAtMs = (raw?.get("quoteDecidedAtMs") as? Number)?.toDouble(),
        creditAmountCents = (raw?.get("creditAmountCents") as? Number)?.toLong(),
        creditTarget = raw?.get("creditTarget") as? String,
        creditRedeemedAtMs = (raw?.get("creditRedeemedAtMs") as? Number)?.toDouble(),
        lineItems = (raw?.get("lineItems") as? List<*>)?.mapNotNull { contractRawMap(it)?.let { nested -> decodeInvoiceLineItemDto(nested) } },
        payMethods = (raw?.get("payMethods") as? List<*>).orEmpty().mapNotNull { contractRawMap(it)?.let { nested -> decodeInvoiceDtoPayMethod(nested) } },
    )

// ---------- acceptQuote ----------

/** Request payload for the `acceptQuote` callable. */
data class AcceptQuoteArgs(
    val invoiceId: String,
    /** Optional: omitted from the payload when null. */
    val kinfolkId: String? = null,
) {
    /**
     * The wire payload for this request, in the `recordPaymentPayload` convention:
     * a pure map, no Firebase types, so a test can assert it without static init.
     */
    fun toPayload(): Map<String, Any?> = buildMap<String, Any?> {
        put("invoiceId", invoiceId)
        if (kinfolkId != null) put("kinfolkId", kinfolkId)
    }
}

/** Response from the `acceptQuote` callable. */
data class AcceptQuoteResult(
    val ok: Boolean,
    val invoiceId: String,
    /** One of `quote`, `draft`, `cancelled`, `credit`, `redeemed`, `paid`, `zero`, `open`. `""` when the payload omits it. */
    val status: String,
)

/**
 * Fail-soft decode of `AcceptQuoteResult` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeAcceptQuoteResult(raw: Map<String, Any?>?): AcceptQuoteResult =
    AcceptQuoteResult(
        ok = raw?.get("ok") as? Boolean ?: false,
        invoiceId = (raw?.get("invoiceId") as? String).orEmpty(),
        status = (raw?.get("status") as? String).orEmpty(),
    )

// ---------- archiveInvoice ----------

/** Request payload for the `archiveInvoice` callable. */
data class ArchiveInvoiceArgs(
    val invoiceId: String,
    /** Optional: omitted from the payload when null. */
    val force: Boolean? = null,
) {
    /**
     * The wire payload for this request, in the `recordPaymentPayload` convention:
     * a pure map, no Firebase types, so a test can assert it without static init.
     */
    fun toPayload(): Map<String, Any?> = buildMap<String, Any?> {
        put("invoiceId", invoiceId)
        if (force != null) put("force", force)
    }
}

/** Response from the `archiveInvoice` callable. */
data class ArchiveInvoiceResult(
    val ok: Boolean,
    val invoiceId: String,
)

/**
 * Fail-soft decode of `ArchiveInvoiceResult` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeArchiveInvoiceResult(raw: Map<String, Any?>?): ArchiveInvoiceResult =
    ArchiveInvoiceResult(
        ok = raw?.get("ok") as? Boolean ?: false,
        invoiceId = (raw?.get("invoiceId") as? String).orEmpty(),
    )

// ---------- createInvoice ----------

/** Nested in the `createInvoice` contract. */
data class CreateInvoiceArgsLineItem(
    val description: String,
    val qty: Double,
    val unitCents: Long,
    /** Optional: omitted from the payload when null. */
    val discountCents: Long? = null,
    /** Optional: omitted from the payload when null. */
    val sessionId: String? = null,
) {
    /**
     * The wire payload for this request, in the `recordPaymentPayload` convention:
     * a pure map, no Firebase types, so a test can assert it without static init.
     */
    fun toPayload(): Map<String, Any?> = buildMap<String, Any?> {
        put("description", description)
        put("qty", qty)
        put("unitCents", unitCents)
        if (discountCents != null) put("discountCents", discountCents)
        if (sessionId != null) put("sessionId", sessionId)
    }
}

/** Request payload for the `createInvoice` callable. */
data class CreateInvoiceArgs(
    val familyId: String,
    /** The server defaults this to `""`. */
    val kinfolkName: String = "",
    /** Optional: omitted from the payload when null. */
    val invoiceNumber: String? = null,
    /** The server defaults this to `""`. */
    val client: String = "",
    /** The server defaults this to `""`. */
    val address: String = "",
    /** The server defaults this to `""`. */
    val date: String = "",
    /** The server defaults this to `""`. */
    val terms: String = "",
    /** The server defaults this to `""`. */
    val dueDate: String = "",
    /**
     * One of `due_on_receipt`, `net_7`, `net_14`, `net_30`, `due_on_last_visit`, `net_7_after_last_visit`, `net_14_after_last_visit`, `custom`.
     * Optional: omitted from the payload when null.
     */
    val termsCode: String? = null,
    /** The server defaults this to `""`. */
    val discount: String = "",
    val total: Double,
    val amountDue: Double,
    /** The server defaults this to `""`. */
    val status: String = "",
    /** The server defaults this to `emptyList()`. */
    val sessionIds: List<String> = emptyList(),
    /** Optional: omitted from the payload when null. */
    val lineItems: List<CreateInvoiceArgsLineItem>? = null,
    /** Optional: omitted from the payload when null. */
    val invoiceDiscountCents: Long? = null,
    /** Optional: omitted from the payload when null. */
    val idempotencyKey: String? = null,
) {
    /**
     * The wire payload for this request, in the `recordPaymentPayload` convention:
     * a pure map, no Firebase types, so a test can assert it without static init.
     */
    fun toPayload(): Map<String, Any?> = buildMap<String, Any?> {
        put("familyId", familyId)
        put("kinfolkName", kinfolkName)
        if (invoiceNumber != null) put("invoiceNumber", invoiceNumber)
        put("client", client)
        put("address", address)
        put("date", date)
        put("terms", terms)
        put("dueDate", dueDate)
        if (termsCode != null) put("termsCode", termsCode)
        put("discount", discount)
        put("total", total)
        put("amountDue", amountDue)
        put("status", status)
        put("sessionIds", sessionIds)
        if (lineItems != null) put("lineItems", lineItems.map { it.toPayload() })
        if (invoiceDiscountCents != null) put("invoiceDiscountCents", invoiceDiscountCents)
        if (idempotencyKey != null) put("idempotencyKey", idempotencyKey)
    }
}

/** Response from the `createInvoice` callable. */
data class CreateInvoiceResult(
    val ok: Boolean,
    val invoiceId: String,
)

/**
 * Fail-soft decode of `CreateInvoiceResult` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeCreateInvoiceResult(raw: Map<String, Any?>?): CreateInvoiceResult =
    CreateInvoiceResult(
        ok = raw?.get("ok") as? Boolean ?: false,
        invoiceId = (raw?.get("invoiceId") as? String).orEmpty(),
    )

// ---------- createQuote ----------

/** Nested in the `createQuote` contract. */
data class CreateQuoteArgsLineItem(
    val description: String,
    val qty: Double,
    val unitCents: Long,
    /** Optional: omitted from the payload when null. */
    val discountCents: Long? = null,
    /** Optional: omitted from the payload when null. */
    val sessionId: String? = null,
) {
    /**
     * The wire payload for this request, in the `recordPaymentPayload` convention:
     * a pure map, no Firebase types, so a test can assert it without static init.
     */
    fun toPayload(): Map<String, Any?> = buildMap<String, Any?> {
        put("description", description)
        put("qty", qty)
        put("unitCents", unitCents)
        if (discountCents != null) put("discountCents", discountCents)
        if (sessionId != null) put("sessionId", sessionId)
    }
}

/** Request payload for the `createQuote` callable. */
data class CreateQuoteArgs(
    val familyId: String,
    /** The server defaults this to `""`. */
    val kinfolkName: String = "",
    /** Optional: omitted from the payload when null. */
    val invoiceNumber: String? = null,
    /** The server defaults this to `""`. */
    val client: String = "",
    /** The server defaults this to `""`. */
    val address: String = "",
    /** The server defaults this to `""`. */
    val date: String = "",
    /** The server defaults this to `""`. */
    val terms: String = "",
    /** The server defaults this to `""`. */
    val dueDate: String = "",
    /**
     * One of `due_on_receipt`, `net_7`, `net_14`, `net_30`, `due_on_last_visit`, `net_7_after_last_visit`, `net_14_after_last_visit`, `custom`.
     * Optional: omitted from the payload when null.
     */
    val termsCode: String? = null,
    /** The server defaults this to `""`. */
    val discount: String = "",
    val total: Double,
    val amountDue: Double,
    /** The server defaults this to `""`. */
    val status: String = "",
    /** The server defaults this to `emptyList()`. */
    val sessionIds: List<String> = emptyList(),
    /** Optional: omitted from the payload when null. */
    val lineItems: List<CreateQuoteArgsLineItem>? = null,
    /** Optional: omitted from the payload when null. */
    val invoiceDiscountCents: Long? = null,
    /** The server defaults this to `false`. */
    val sendToKinfolk: Boolean = false,
    /** Optional: omitted from the payload when null. */
    val idempotencyKey: String? = null,
) {
    /**
     * The wire payload for this request, in the `recordPaymentPayload` convention:
     * a pure map, no Firebase types, so a test can assert it without static init.
     */
    fun toPayload(): Map<String, Any?> = buildMap<String, Any?> {
        put("familyId", familyId)
        put("kinfolkName", kinfolkName)
        if (invoiceNumber != null) put("invoiceNumber", invoiceNumber)
        put("client", client)
        put("address", address)
        put("date", date)
        put("terms", terms)
        put("dueDate", dueDate)
        if (termsCode != null) put("termsCode", termsCode)
        put("discount", discount)
        put("total", total)
        put("amountDue", amountDue)
        put("status", status)
        put("sessionIds", sessionIds)
        if (lineItems != null) put("lineItems", lineItems.map { it.toPayload() })
        if (invoiceDiscountCents != null) put("invoiceDiscountCents", invoiceDiscountCents)
        put("sendToKinfolk", sendToKinfolk)
        if (idempotencyKey != null) put("idempotencyKey", idempotencyKey)
    }
}

/** Response from the `createQuote` callable. */
data class CreateQuoteResult(
    val ok: Boolean,
    val invoiceId: String,
)

/**
 * Fail-soft decode of `CreateQuoteResult` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeCreateQuoteResult(raw: Map<String, Any?>?): CreateQuoteResult =
    CreateQuoteResult(
        ok = raw?.get("ok") as? Boolean ?: false,
        invoiceId = (raw?.get("invoiceId") as? String).orEmpty(),
    )

// ---------- denyQuote ----------

/** Request payload for the `denyQuote` callable. */
data class DenyQuoteArgs(
    val invoiceId: String,
    /** Optional: omitted from the payload when null. */
    val kinfolkId: String? = null,
) {
    /**
     * The wire payload for this request, in the `recordPaymentPayload` convention:
     * a pure map, no Firebase types, so a test can assert it without static init.
     */
    fun toPayload(): Map<String, Any?> = buildMap<String, Any?> {
        put("invoiceId", invoiceId)
        if (kinfolkId != null) put("kinfolkId", kinfolkId)
    }
}

/** Response from the `denyQuote` callable. */
data class DenyQuoteResult(
    val ok: Boolean,
    val invoiceId: String,
    /** One of `quote`, `draft`, `cancelled`, `credit`, `redeemed`, `paid`, `zero`, `open`. `""` when the payload omits it. */
    val status: String,
)

/**
 * Fail-soft decode of `DenyQuoteResult` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeDenyQuoteResult(raw: Map<String, Any?>?): DenyQuoteResult =
    DenyQuoteResult(
        ok = raw?.get("ok") as? Boolean ?: false,
        invoiceId = (raw?.get("invoiceId") as? String).orEmpty(),
        status = (raw?.get("status") as? String).orEmpty(),
    )

// ---------- generateInvoicePdf ----------

/** Request payload for the `generateInvoicePdf` callable. */
data class GenerateInvoicePdfArgs(
    val invoiceId: String,
) {
    /**
     * The wire payload for this request, in the `recordPaymentPayload` convention:
     * a pure map, no Firebase types, so a test can assert it without static init.
     */
    fun toPayload(): Map<String, Any?> = buildMap<String, Any?> {
        put("invoiceId", invoiceId)
    }
}

/** Response from the `generateInvoicePdf` callable. */
data class GenerateInvoicePdfResult(
    val ok: Boolean,
    val invoiceId: String,
    val pdfUrl: String,
)

/**
 * Fail-soft decode of `GenerateInvoicePdfResult` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeGenerateInvoicePdfResult(raw: Map<String, Any?>?): GenerateInvoicePdfResult =
    GenerateInvoicePdfResult(
        ok = raw?.get("ok") as? Boolean ?: false,
        invoiceId = (raw?.get("invoiceId") as? String).orEmpty(),
        pdfUrl = (raw?.get("pdfUrl") as? String).orEmpty(),
    )

// ---------- generateReceipt ----------

/** Request payload for the `generateReceipt` callable. */
data class GenerateReceiptArgs(
    val invoiceId: String,
) {
    /**
     * The wire payload for this request, in the `recordPaymentPayload` convention:
     * a pure map, no Firebase types, so a test can assert it without static init.
     */
    fun toPayload(): Map<String, Any?> = buildMap<String, Any?> {
        put("invoiceId", invoiceId)
    }
}

/** Response from the `generateReceipt` callable. */
data class GenerateReceiptResult(
    val ok: Boolean,
)

/**
 * Fail-soft decode of `GenerateReceiptResult` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeGenerateReceiptResult(raw: Map<String, Any?>?): GenerateReceiptResult =
    GenerateReceiptResult(
        ok = raw?.get("ok") as? Boolean ?: false,
    )

// ---------- getInvoiceLedger ----------

/** Request payload for the `getInvoiceLedger` callable. */
data class GetInvoiceLedgerArgs(
    val invoiceId: String,
) {
    /**
     * The wire payload for this request, in the `recordPaymentPayload` convention:
     * a pure map, no Firebase types, so a test can assert it without static init.
     */
    fun toPayload(): Map<String, Any?> = buildMap<String, Any?> {
        put("invoiceId", invoiceId)
    }
}

/** Nested in the `getInvoiceLedger` contract. */
data class GetInvoiceLedgerResultPayment(
    val paymentId: String,
    val amountCents: Long,
    val method: String?,
    val reference: String?,
    val paidAt: String?,
    val recordedBy: String?,
    val sourcePaymentId: String?,
)

/**
 * Fail-soft decode of `GetInvoiceLedgerResultPayment` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeGetInvoiceLedgerResultPayment(raw: Map<String, Any?>?): GetInvoiceLedgerResultPayment =
    GetInvoiceLedgerResultPayment(
        paymentId = (raw?.get("paymentId") as? String).orEmpty(),
        amountCents = (raw?.get("amountCents") as? Number)?.toLong() ?: 0L,
        method = raw?.get("method") as? String,
        reference = raw?.get("reference") as? String,
        paidAt = raw?.get("paidAt") as? String,
        recordedBy = raw?.get("recordedBy") as? String,
        sourcePaymentId = raw?.get("sourcePaymentId") as? String,
    )

/** Nested in the `getInvoiceLedger` contract. */
data class GetInvoiceLedgerResultLedgerPayment(
    val paymentId: String,
    val amountCents: Long,
    val amountResolved: Boolean,
    val tipCents: Long,
    val feeCents: Long,
    /** One of `gross`, `net`, `unknown`. `""` when the payload omits it. */
    val tipBasis: String,
    val reconciles: Boolean,
    val appliedCents: Long,
    val unappliedCents: Long,
    val proceedsCents: Long,
    val autoApply: Boolean,
    val appliedInvoiceId: String,
    val appliedInvoiceNumber: String,
    val method: String,
    val reference: String,
    val date: String,
    val notes: String,
    val recordedBy: String?,
)

/**
 * Fail-soft decode of `GetInvoiceLedgerResultLedgerPayment` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeGetInvoiceLedgerResultLedgerPayment(raw: Map<String, Any?>?): GetInvoiceLedgerResultLedgerPayment =
    GetInvoiceLedgerResultLedgerPayment(
        paymentId = (raw?.get("paymentId") as? String).orEmpty(),
        amountCents = (raw?.get("amountCents") as? Number)?.toLong() ?: 0L,
        amountResolved = raw?.get("amountResolved") as? Boolean ?: false,
        tipCents = (raw?.get("tipCents") as? Number)?.toLong() ?: 0L,
        feeCents = (raw?.get("feeCents") as? Number)?.toLong() ?: 0L,
        tipBasis = (raw?.get("tipBasis") as? String).orEmpty(),
        reconciles = raw?.get("reconciles") as? Boolean ?: false,
        appliedCents = (raw?.get("appliedCents") as? Number)?.toLong() ?: 0L,
        unappliedCents = (raw?.get("unappliedCents") as? Number)?.toLong() ?: 0L,
        proceedsCents = (raw?.get("proceedsCents") as? Number)?.toLong() ?: 0L,
        autoApply = raw?.get("autoApply") as? Boolean ?: false,
        appliedInvoiceId = (raw?.get("appliedInvoiceId") as? String).orEmpty(),
        appliedInvoiceNumber = (raw?.get("appliedInvoiceNumber") as? String).orEmpty(),
        method = (raw?.get("method") as? String).orEmpty(),
        reference = (raw?.get("reference") as? String).orEmpty(),
        date = (raw?.get("date") as? String).orEmpty(),
        notes = (raw?.get("notes") as? String).orEmpty(),
        recordedBy = raw?.get("recordedBy") as? String,
    )

/** Nested in the `getInvoiceLedger` contract. */
data class GetInvoiceLedgerResultSession(
    val sessionId: String,
    val serviceType: String,
    val status: String,
    val startTime: String,
    val completedAt: String?,
    val durationMinutes: Double?,
    val linkedBack: Boolean,
)

/**
 * Fail-soft decode of `GetInvoiceLedgerResultSession` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeGetInvoiceLedgerResultSession(raw: Map<String, Any?>?): GetInvoiceLedgerResultSession =
    GetInvoiceLedgerResultSession(
        sessionId = (raw?.get("sessionId") as? String).orEmpty(),
        serviceType = (raw?.get("serviceType") as? String).orEmpty(),
        status = (raw?.get("status") as? String).orEmpty(),
        startTime = (raw?.get("startTime") as? String).orEmpty(),
        completedAt = raw?.get("completedAt") as? String,
        durationMinutes = (raw?.get("durationMinutes") as? Number)?.toDouble(),
        linkedBack = raw?.get("linkedBack") as? Boolean ?: false,
    )

/** Response from the `getInvoiceLedger` callable. */
data class GetInvoiceLedgerResult(
    val invoiceId: String,
    val payments: List<GetInvoiceLedgerResultPayment>,
    val paidCents: Long,
    val totalCents: Long,
    val amountDueCents: Long,
    val ledgerPayments: List<GetInvoiceLedgerResultLedgerPayment>,
    val unlinkedKinfolkPayments: List<GetInvoiceLedgerResultLedgerPayment>,
    val unresolvedAmountCount: Long,
    val sessions: List<GetInvoiceLedgerResultSession>,
    val missingSessionIds: List<String>,
    val orphanSessionIds: List<String>,
    val truncated: Boolean,
)

/**
 * Fail-soft decode of `GetInvoiceLedgerResult` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeGetInvoiceLedgerResult(raw: Map<String, Any?>?): GetInvoiceLedgerResult =
    GetInvoiceLedgerResult(
        invoiceId = (raw?.get("invoiceId") as? String).orEmpty(),
        payments = (raw?.get("payments") as? List<*>).orEmpty().mapNotNull { contractRawMap(it)?.let { nested -> decodeGetInvoiceLedgerResultPayment(nested) } },
        paidCents = (raw?.get("paidCents") as? Number)?.toLong() ?: 0L,
        totalCents = (raw?.get("totalCents") as? Number)?.toLong() ?: 0L,
        amountDueCents = (raw?.get("amountDueCents") as? Number)?.toLong() ?: 0L,
        ledgerPayments = (raw?.get("ledgerPayments") as? List<*>).orEmpty().mapNotNull { contractRawMap(it)?.let { nested -> decodeGetInvoiceLedgerResultLedgerPayment(nested) } },
        unlinkedKinfolkPayments = (raw?.get("unlinkedKinfolkPayments") as? List<*>).orEmpty().mapNotNull { contractRawMap(it)?.let { nested -> decodeGetInvoiceLedgerResultLedgerPayment(nested) } },
        unresolvedAmountCount = (raw?.get("unresolvedAmountCount") as? Number)?.toLong() ?: 0L,
        sessions = (raw?.get("sessions") as? List<*>).orEmpty().mapNotNull { contractRawMap(it)?.let { nested -> decodeGetInvoiceLedgerResultSession(nested) } },
        missingSessionIds = (raw?.get("missingSessionIds") as? List<*>).orEmpty().mapNotNull { it as? String },
        orphanSessionIds = (raw?.get("orphanSessionIds") as? List<*>).orEmpty().mapNotNull { it as? String },
        truncated = raw?.get("truncated") as? Boolean ?: false,
    )

// ---------- getMyInvoicePdf ----------

/** Request payload for the `getMyInvoicePdf` callable. */
data class GetMyInvoicePdfArgs(
    val invoiceId: String,
    /** Optional: omitted from the payload when null. */
    val kinfolkId: String? = null,
) {
    /**
     * The wire payload for this request, in the `recordPaymentPayload` convention:
     * a pure map, no Firebase types, so a test can assert it without static init.
     */
    fun toPayload(): Map<String, Any?> = buildMap<String, Any?> {
        put("invoiceId", invoiceId)
        if (kinfolkId != null) put("kinfolkId", kinfolkId)
    }
}

/** Response from the `getMyInvoicePdf` callable. */
data class GetMyInvoicePdfResult(
    val ok: Boolean,
    val invoiceId: String,
    val pdfUrl: String,
)

/**
 * Fail-soft decode of `GetMyInvoicePdfResult` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeGetMyInvoicePdfResult(raw: Map<String, Any?>?): GetMyInvoicePdfResult =
    GetMyInvoicePdfResult(
        ok = raw?.get("ok") as? Boolean ?: false,
        invoiceId = (raw?.get("invoiceId") as? String).orEmpty(),
        pdfUrl = (raw?.get("pdfUrl") as? String).orEmpty(),
    )

// ---------- getMyInvoices ----------

// No request class: `getMyInvoices` has no zod request schema on the server,
// so there is no authority to generate one from.

/** Response from the `getMyInvoices` callable. */
data class GetMyInvoicesResult(
    val open: List<InvoiceDto>,
    val paid: List<InvoiceDto>,
    val credits: List<InvoiceDto>,
    val accountBalanceCents: Double,
)

/**
 * Fail-soft decode of `GetMyInvoicesResult` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeGetMyInvoicesResult(raw: Map<String, Any?>?): GetMyInvoicesResult =
    GetMyInvoicesResult(
        open = (raw?.get("open") as? List<*>).orEmpty().mapNotNull { contractRawMap(it)?.let { nested -> decodeInvoiceDto(nested) } },
        paid = (raw?.get("paid") as? List<*>).orEmpty().mapNotNull { contractRawMap(it)?.let { nested -> decodeInvoiceDto(nested) } },
        credits = (raw?.get("credits") as? List<*>).orEmpty().mapNotNull { contractRawMap(it)?.let { nested -> decodeInvoiceDto(nested) } },
        accountBalanceCents = (raw?.get("accountBalanceCents") as? Number)?.toDouble() ?: 0.0,
    )

// ---------- linkInvoiceSessions ----------

/** Request payload for the `linkInvoiceSessions` callable. */
data class LinkInvoiceSessionsArgs(
    val invoiceId: String,
    val sessionIds: List<String>,
) {
    /**
     * The wire payload for this request, in the `recordPaymentPayload` convention:
     * a pure map, no Firebase types, so a test can assert it without static init.
     */
    fun toPayload(): Map<String, Any?> = buildMap<String, Any?> {
        put("invoiceId", invoiceId)
        put("sessionIds", sessionIds)
    }
}

/** Response from the `linkInvoiceSessions` callable. */
data class LinkInvoiceSessionsResult(
    val ok: Boolean,
    val invoiceId: String,
    val sessionIds: List<String>,
    val added: List<String>,
    val removed: List<String>,
    /** One of `quote`, `draft`, `cancelled`, `credit`, `redeemed`, `paid`, `zero`, `open`. `""` when the payload omits it. */
    val status: String,
    /** One of `all`, `metadataOnly`, `none`. `""` when the payload omits it. */
    val editScope: String,
)

/**
 * Fail-soft decode of `LinkInvoiceSessionsResult` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeLinkInvoiceSessionsResult(raw: Map<String, Any?>?): LinkInvoiceSessionsResult =
    LinkInvoiceSessionsResult(
        ok = raw?.get("ok") as? Boolean ?: false,
        invoiceId = (raw?.get("invoiceId") as? String).orEmpty(),
        sessionIds = (raw?.get("sessionIds") as? List<*>).orEmpty().mapNotNull { it as? String },
        added = (raw?.get("added") as? List<*>).orEmpty().mapNotNull { it as? String },
        removed = (raw?.get("removed") as? List<*>).orEmpty().mapNotNull { it as? String },
        status = (raw?.get("status") as? String).orEmpty(),
        editScope = (raw?.get("editScope") as? String).orEmpty(),
    )

// ---------- listPayments ----------

/** Request payload for the `listPayments` callable. */
data class ListPaymentsArgs(
    /** Optional: omitted from the payload when null. */
    val limit: Long? = null,
    /** Optional: omitted from the payload when null. */
    val startAfterId: String? = null,
) {
    /**
     * The wire payload for this request, in the `recordPaymentPayload` convention:
     * a pure map, no Firebase types, so a test can assert it without static init.
     */
    fun toPayload(): Map<String, Any?> = buildMap<String, Any?> {
        if (limit != null) put("limit", limit)
        if (startAfterId != null) put("startAfterId", startAfterId)
    }
}

/** Nested in the `listPayments` contract. */
data class ListPaymentsResultPayment(
    val paymentId: String,
    val kinfolkId: String,
    val kinfolkName: String,
    val amountCents: Long,
    val amountResolved: Boolean,
    val tipCents: Long,
    val feeCents: Long,
    /** One of `gross`, `net`, `unknown`. `""` when the payload omits it. */
    val tipBasis: String,
    val reconciles: Boolean,
    val appliedCents: Long,
    val unappliedCents: Long,
    val proceedsCents: Long,
    val autoApply: Boolean,
    val invoiceId: String,
    val invoiceNumber: String,
    val appliedInvoiceId: String,
    val appliedInvoiceNumber: String,
    val method: String,
    val reference: String,
    val date: String,
    val notes: String,
    val recordedBy: String?,
)

/**
 * Fail-soft decode of `ListPaymentsResultPayment` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeListPaymentsResultPayment(raw: Map<String, Any?>?): ListPaymentsResultPayment =
    ListPaymentsResultPayment(
        paymentId = (raw?.get("paymentId") as? String).orEmpty(),
        kinfolkId = (raw?.get("kinfolkId") as? String).orEmpty(),
        kinfolkName = (raw?.get("kinfolkName") as? String).orEmpty(),
        amountCents = (raw?.get("amountCents") as? Number)?.toLong() ?: 0L,
        amountResolved = raw?.get("amountResolved") as? Boolean ?: false,
        tipCents = (raw?.get("tipCents") as? Number)?.toLong() ?: 0L,
        feeCents = (raw?.get("feeCents") as? Number)?.toLong() ?: 0L,
        tipBasis = (raw?.get("tipBasis") as? String).orEmpty(),
        reconciles = raw?.get("reconciles") as? Boolean ?: false,
        appliedCents = (raw?.get("appliedCents") as? Number)?.toLong() ?: 0L,
        unappliedCents = (raw?.get("unappliedCents") as? Number)?.toLong() ?: 0L,
        proceedsCents = (raw?.get("proceedsCents") as? Number)?.toLong() ?: 0L,
        autoApply = raw?.get("autoApply") as? Boolean ?: false,
        invoiceId = (raw?.get("invoiceId") as? String).orEmpty(),
        invoiceNumber = (raw?.get("invoiceNumber") as? String).orEmpty(),
        appliedInvoiceId = (raw?.get("appliedInvoiceId") as? String).orEmpty(),
        appliedInvoiceNumber = (raw?.get("appliedInvoiceNumber") as? String).orEmpty(),
        method = (raw?.get("method") as? String).orEmpty(),
        reference = (raw?.get("reference") as? String).orEmpty(),
        date = (raw?.get("date") as? String).orEmpty(),
        notes = (raw?.get("notes") as? String).orEmpty(),
        recordedBy = raw?.get("recordedBy") as? String,
    )

/** Response from the `listPayments` callable. */
data class ListPaymentsResult(
    val payments: List<ListPaymentsResultPayment>,
    val truncated: Boolean,
    val nextCursor: String?,
    val unresolvedAmountCount: Long,
)

/**
 * Fail-soft decode of `ListPaymentsResult` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeListPaymentsResult(raw: Map<String, Any?>?): ListPaymentsResult =
    ListPaymentsResult(
        payments = (raw?.get("payments") as? List<*>).orEmpty().mapNotNull { contractRawMap(it)?.let { nested -> decodeListPaymentsResultPayment(nested) } },
        truncated = raw?.get("truncated") as? Boolean ?: false,
        nextCursor = raw?.get("nextCursor") as? String,
        unresolvedAmountCount = (raw?.get("unresolvedAmountCount") as? Number)?.toLong() ?: 0L,
    )

// ---------- listUninvoicedSessions ----------

/**
 * Request payload for the `listUninvoicedSessions` callable.
 * The server also enforces a cross-field rule this class cannot express (zod .refine);
 * a payload that satisfies these types can still be refused.
 */
data class ListUninvoicedSessionsArgs(
    /** Optional: omitted from the payload when null. */
    val kinfolkId: String? = null,
    /** Optional: omitted from the payload when null. */
    val from: String? = null,
    /** Optional: omitted from the payload when null. */
    val to: String? = null,
) {
    /**
     * The wire payload for this request, in the `recordPaymentPayload` convention:
     * a pure map, no Firebase types, so a test can assert it without static init.
     */
    fun toPayload(): Map<String, Any?> = buildMap<String, Any?> {
        if (kinfolkId != null) put("kinfolkId", kinfolkId)
        if (from != null) put("from", from)
        if (to != null) put("to", to)
    }
}

/** Nested in the `listUninvoicedSessions` contract. */
data class ListUninvoicedSessionsResultSession(
    val sessionId: String,
    val kinfolkId: String,
    val serviceType: String,
    val durationMinutes: Double,
    val startTime: String,
    val unitCents: Long?,
)

/**
 * Fail-soft decode of `ListUninvoicedSessionsResultSession` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeListUninvoicedSessionsResultSession(raw: Map<String, Any?>?): ListUninvoicedSessionsResultSession =
    ListUninvoicedSessionsResultSession(
        sessionId = (raw?.get("sessionId") as? String).orEmpty(),
        kinfolkId = (raw?.get("kinfolkId") as? String).orEmpty(),
        serviceType = (raw?.get("serviceType") as? String).orEmpty(),
        durationMinutes = (raw?.get("durationMinutes") as? Number)?.toDouble() ?: 0.0,
        startTime = (raw?.get("startTime") as? String).orEmpty(),
        unitCents = (raw?.get("unitCents") as? Number)?.toLong(),
    )

/** Nested in the `listUninvoicedSessions` contract. */
data class ListUninvoicedSessionsResultUnpriceable(
    val sessionId: String,
    val serviceType: String,
)

/**
 * Fail-soft decode of `ListUninvoicedSessionsResultUnpriceable` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeListUninvoicedSessionsResultUnpriceable(raw: Map<String, Any?>?): ListUninvoicedSessionsResultUnpriceable =
    ListUninvoicedSessionsResultUnpriceable(
        sessionId = (raw?.get("sessionId") as? String).orEmpty(),
        serviceType = (raw?.get("serviceType") as? String).orEmpty(),
    )

/** Nested in the `listUninvoicedSessions` contract. */
data class ListUninvoicedSessionsResultUnplaceable(
    val sessionId: String,
    val kinfolkId: String,
)

/**
 * Fail-soft decode of `ListUninvoicedSessionsResultUnplaceable` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeListUninvoicedSessionsResultUnplaceable(raw: Map<String, Any?>?): ListUninvoicedSessionsResultUnplaceable =
    ListUninvoicedSessionsResultUnplaceable(
        sessionId = (raw?.get("sessionId") as? String).orEmpty(),
        kinfolkId = (raw?.get("kinfolkId") as? String).orEmpty(),
    )

/** Nested in the `listUninvoicedSessions` contract. */
data class ListUninvoicedSessionsResultExcluded(
    val sessionId: String,
    val kinfolkId: String,
    val serviceType: String,
    val startTime: String,
    val reason: String,
)

/**
 * Fail-soft decode of `ListUninvoicedSessionsResultExcluded` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeListUninvoicedSessionsResultExcluded(raw: Map<String, Any?>?): ListUninvoicedSessionsResultExcluded =
    ListUninvoicedSessionsResultExcluded(
        sessionId = (raw?.get("sessionId") as? String).orEmpty(),
        kinfolkId = (raw?.get("kinfolkId") as? String).orEmpty(),
        serviceType = (raw?.get("serviceType") as? String).orEmpty(),
        startTime = (raw?.get("startTime") as? String).orEmpty(),
        reason = (raw?.get("reason") as? String).orEmpty(),
    )

/** Response from the `listUninvoicedSessions` callable. */
data class ListUninvoicedSessionsResult(
    val sessions: List<ListUninvoicedSessionsResultSession>,
    val unpriceable: List<ListUninvoicedSessionsResultUnpriceable>,
    val unplaceable: List<ListUninvoicedSessionsResultUnplaceable>,
    val excluded: List<ListUninvoicedSessionsResultExcluded>,
    val rateCardLoaded: Boolean,
    val scanned: Long,
    val truncated: Boolean,
)

/**
 * Fail-soft decode of `ListUninvoicedSessionsResult` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeListUninvoicedSessionsResult(raw: Map<String, Any?>?): ListUninvoicedSessionsResult =
    ListUninvoicedSessionsResult(
        sessions = (raw?.get("sessions") as? List<*>).orEmpty().mapNotNull { contractRawMap(it)?.let { nested -> decodeListUninvoicedSessionsResultSession(nested) } },
        unpriceable = (raw?.get("unpriceable") as? List<*>).orEmpty().mapNotNull { contractRawMap(it)?.let { nested -> decodeListUninvoicedSessionsResultUnpriceable(nested) } },
        unplaceable = (raw?.get("unplaceable") as? List<*>).orEmpty().mapNotNull { contractRawMap(it)?.let { nested -> decodeListUninvoicedSessionsResultUnplaceable(nested) } },
        excluded = (raw?.get("excluded") as? List<*>).orEmpty().mapNotNull { contractRawMap(it)?.let { nested -> decodeListUninvoicedSessionsResultExcluded(nested) } },
        rateCardLoaded = raw?.get("rateCardLoaded") as? Boolean ?: false,
        scanned = (raw?.get("scanned") as? Number)?.toLong() ?: 0L,
        truncated = raw?.get("truncated") as? Boolean ?: false,
    )

// ---------- setSessionDoNotInvoice ----------

/** Request payload for the `setSessionDoNotInvoice` callable. */
data class SetSessionDoNotInvoiceArgs(
    val sessionIds: List<String>,
    val doNotInvoice: Boolean,
    /** The server defaults this to `""`. */
    val reason: String = "",
) {
    /**
     * The wire payload for this request, in the `recordPaymentPayload` convention:
     * a pure map, no Firebase types, so a test can assert it without static init.
     */
    fun toPayload(): Map<String, Any?> = buildMap<String, Any?> {
        put("sessionIds", sessionIds)
        put("doNotInvoice", doNotInvoice)
        put("reason", reason)
    }
}

/** Response from the `setSessionDoNotInvoice` callable. */
data class SetSessionDoNotInvoiceResult(
    val ok: Boolean,
    val doNotInvoice: Boolean,
    val changed: List<String>,
    val unchanged: List<String>,
)

/**
 * Fail-soft decode of `SetSessionDoNotInvoiceResult` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeSetSessionDoNotInvoiceResult(raw: Map<String, Any?>?): SetSessionDoNotInvoiceResult =
    SetSessionDoNotInvoiceResult(
        ok = raw?.get("ok") as? Boolean ?: false,
        doNotInvoice = raw?.get("doNotInvoice") as? Boolean ?: false,
        changed = (raw?.get("changed") as? List<*>).orEmpty().mapNotNull { it as? String },
        unchanged = (raw?.get("unchanged") as? List<*>).orEmpty().mapNotNull { it as? String },
    )

// ---------- markInvoicePaid ----------

/** Request payload for the `markInvoicePaid` callable. */
data class MarkInvoicePaidArgs(
    val invoiceId: String,
    /** Optional: omitted from the payload when null. */
    val amount: Double? = null,
    /** Optional: omitted from the payload when null. */
    val method: String? = null,
    /** Optional: omitted from the payload when null. */
    val reference: String? = null,
    /** Optional: omitted from the payload when null. */
    val paidAt: String? = null,
    /** Optional: omitted from the payload when null. */
    val idempotencyKey: String? = null,
) {
    /**
     * The wire payload for this request, in the `recordPaymentPayload` convention:
     * a pure map, no Firebase types, so a test can assert it without static init.
     */
    fun toPayload(): Map<String, Any?> = buildMap<String, Any?> {
        put("invoiceId", invoiceId)
        if (amount != null) put("amount", amount)
        if (method != null) put("method", method)
        if (reference != null) put("reference", reference)
        if (paidAt != null) put("paidAt", paidAt)
        if (idempotencyKey != null) put("idempotencyKey", idempotencyKey)
    }
}

/** Response from the `markInvoicePaid` callable. */
data class MarkInvoicePaidResult(
    val ok: Boolean,
    val invoiceId: String,
    val paymentId: String,
    /** One of `unpaid`, `partial`, `settled`, `overpaid`. `""` when the payload omits it. */
    val state: String,
    val totalCents: Long,
    val paidCents: Long,
    val amountDueCents: Long,
    val overpaidCents: Long,
)

/**
 * Fail-soft decode of `MarkInvoicePaidResult` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeMarkInvoicePaidResult(raw: Map<String, Any?>?): MarkInvoicePaidResult =
    MarkInvoicePaidResult(
        ok = raw?.get("ok") as? Boolean ?: false,
        invoiceId = (raw?.get("invoiceId") as? String).orEmpty(),
        paymentId = (raw?.get("paymentId") as? String).orEmpty(),
        state = (raw?.get("state") as? String).orEmpty(),
        totalCents = (raw?.get("totalCents") as? Number)?.toLong() ?: 0L,
        paidCents = (raw?.get("paidCents") as? Number)?.toLong() ?: 0L,
        amountDueCents = (raw?.get("amountDueCents") as? Number)?.toLong() ?: 0L,
        overpaidCents = (raw?.get("overpaidCents") as? Number)?.toLong() ?: 0L,
    )

// ---------- payInvoice ----------

/** Request payload for the `payInvoice` callable. */
data class PayInvoiceArgs(
    val invoiceId: String,
    /** Optional: omitted from the payload when null. */
    val kinfolkId: String? = null,
    val successUrl: String,
    val cancelUrl: String,
    /** Optional: omitted from the payload when null. */
    val idempotencyKey: String? = null,
) {
    /**
     * The wire payload for this request, in the `recordPaymentPayload` convention:
     * a pure map, no Firebase types, so a test can assert it without static init.
     */
    fun toPayload(): Map<String, Any?> = buildMap<String, Any?> {
        put("invoiceId", invoiceId)
        if (kinfolkId != null) put("kinfolkId", kinfolkId)
        put("successUrl", successUrl)
        put("cancelUrl", cancelUrl)
        if (idempotencyKey != null) put("idempotencyKey", idempotencyKey)
    }
}

/** Response from the `payInvoice` callable. */
data class PayInvoiceResult(
    val checkoutUrl: String,
    val sessionId: String,
    val amountCents: Long,
    val currency: String,
)

/**
 * Fail-soft decode of `PayInvoiceResult` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodePayInvoiceResult(raw: Map<String, Any?>?): PayInvoiceResult =
    PayInvoiceResult(
        checkoutUrl = (raw?.get("checkoutUrl") as? String).orEmpty(),
        sessionId = (raw?.get("sessionId") as? String).orEmpty(),
        amountCents = (raw?.get("amountCents") as? Number)?.toLong() ?: 0L,
        currency = (raw?.get("currency") as? String).orEmpty(),
    )

// ---------- postInvoiceEvent ----------

/** Request payload for the `postInvoiceEvent` callable. */
data class PostInvoiceEventArgs(
    val familyId: String,
    val invoiceId: String,
    val payload: Map<String, Any?>,
) {
    /**
     * The wire payload for this request, in the `recordPaymentPayload` convention:
     * a pure map, no Firebase types, so a test can assert it without static init.
     */
    fun toPayload(): Map<String, Any?> = buildMap<String, Any?> {
        put("familyId", familyId)
        put("invoiceId", invoiceId)
        put("payload", payload)
    }
}

/** Response from the `postInvoiceEvent` callable. */
data class PostInvoiceEventResult(
    val ok: Boolean,
)

/**
 * Fail-soft decode of `PostInvoiceEventResult` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodePostInvoiceEventResult(raw: Map<String, Any?>?): PostInvoiceEventResult =
    PostInvoiceEventResult(
        ok = raw?.get("ok") as? Boolean ?: false,
    )

// ---------- recordPayment ----------

/** Nested in the `recordPayment` contract. */
data class RecordPaymentArgsApply(
    val invoiceId: String,
    /** The server defaults this to `""`. */
    val invoiceNumber: String = "",
    val amount: Double,
) {
    /**
     * The wire payload for this request, in the `recordPaymentPayload` convention:
     * a pure map, no Firebase types, so a test can assert it without static init.
     */
    fun toPayload(): Map<String, Any?> = buildMap<String, Any?> {
        put("invoiceId", invoiceId)
        put("invoiceNumber", invoiceNumber)
        put("amount", amount)
    }
}

/** Request payload for the `recordPayment` callable. */
data class RecordPaymentArgs(
    /** The server defaults this to `""`. */
    val kinfolkId: String = "",
    /** The server defaults this to `""`. */
    val kinfolkName: String = "",
    /** The server defaults this to `""`. */
    val client: String = "",
    /** The server defaults this to `""`. */
    val address: String = "",
    /** The server defaults this to `""`. */
    val date: String = "",
    /** The server defaults this to `""`. */
    val paymentMethod: String = "",
    /** The server defaults this to `""`. */
    val referenceNumber: String = "",
    /** The server defaults this to `""`. */
    val email: String = "",
    val amount: Double,
    /** The server defaults this to `0.0`. */
    val tip: Double = 0.0,
    /** The server defaults this to `0.0`. */
    val fee: Double = 0.0,
    /** The server defaults this to `""`. */
    val notes: String = "",
    /** The server defaults this to `""`. */
    val invoiceId: String = "",
    /** The server defaults this to `""`. */
    val invoiceNumber: String = "",
    /** Optional: omitted from the payload when null. */
    val apply: RecordPaymentArgsApply? = null,
    /** The server defaults this to `false`. */
    val autoApply: Boolean = false,
    /** The server defaults this to `false`. */
    val sendConfirmationEmail: Boolean = false,
    /** Optional: omitted from the payload when null. */
    val idempotencyKey: String? = null,
) {
    /**
     * The wire payload for this request, in the `recordPaymentPayload` convention:
     * a pure map, no Firebase types, so a test can assert it without static init.
     */
    fun toPayload(): Map<String, Any?> = buildMap<String, Any?> {
        put("kinfolkId", kinfolkId)
        put("kinfolkName", kinfolkName)
        put("client", client)
        put("address", address)
        put("date", date)
        put("paymentMethod", paymentMethod)
        put("referenceNumber", referenceNumber)
        put("email", email)
        put("amount", amount)
        put("tip", tip)
        put("fee", fee)
        put("notes", notes)
        put("invoiceId", invoiceId)
        put("invoiceNumber", invoiceNumber)
        if (apply != null) put("apply", apply.toPayload())
        put("autoApply", autoApply)
        put("sendConfirmationEmail", sendConfirmationEmail)
        if (idempotencyKey != null) put("idempotencyKey", idempotencyKey)
    }
}

/** Nested in the `recordPayment` contract. */
data class RecordPaymentResultApplication(
    val invoiceId: String,
    val invoiceNumber: String,
    val paymentId: String,
    val appliedCents: Long,
    /** One of `unpaid`, `partial`, `settled`, `overpaid`. `""` when the payload omits it. */
    val state: String,
    val totalCents: Long,
    val paidCents: Long,
    val amountDueCents: Long,
    val overpaidCents: Long,
)

/**
 * Fail-soft decode of `RecordPaymentResultApplication` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeRecordPaymentResultApplication(raw: Map<String, Any?>?): RecordPaymentResultApplication =
    RecordPaymentResultApplication(
        invoiceId = (raw?.get("invoiceId") as? String).orEmpty(),
        invoiceNumber = (raw?.get("invoiceNumber") as? String).orEmpty(),
        paymentId = (raw?.get("paymentId") as? String).orEmpty(),
        appliedCents = (raw?.get("appliedCents") as? Number)?.toLong() ?: 0L,
        state = (raw?.get("state") as? String).orEmpty(),
        totalCents = (raw?.get("totalCents") as? Number)?.toLong() ?: 0L,
        paidCents = (raw?.get("paidCents") as? Number)?.toLong() ?: 0L,
        amountDueCents = (raw?.get("amountDueCents") as? Number)?.toLong() ?: 0L,
        overpaidCents = (raw?.get("overpaidCents") as? Number)?.toLong() ?: 0L,
    )

/** Response from the `recordPayment` callable. */
data class RecordPaymentResult(
    val ok: Boolean,
    val paymentId: String,
    val kinfolkId: String,
    val amountCents: Long,
    val tipCents: Long,
    val feeCents: Long,
    /** One of `gross`, `net`, `unknown`. `""` when the payload omits it. */
    val tipBasis: String,
    val appliedCents: Long,
    val unappliedCents: Long,
    val proceedsCents: Long,
    val tipNetCents: Long,
    val autoApply: Boolean,
    val application: RecordPaymentResultApplication?,
    val creditedToAccountCents: Long,
    val confirmationEmailSent: Boolean,
)

/**
 * Fail-soft decode of `RecordPaymentResult` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeRecordPaymentResult(raw: Map<String, Any?>?): RecordPaymentResult =
    RecordPaymentResult(
        ok = raw?.get("ok") as? Boolean ?: false,
        paymentId = (raw?.get("paymentId") as? String).orEmpty(),
        kinfolkId = (raw?.get("kinfolkId") as? String).orEmpty(),
        amountCents = (raw?.get("amountCents") as? Number)?.toLong() ?: 0L,
        tipCents = (raw?.get("tipCents") as? Number)?.toLong() ?: 0L,
        feeCents = (raw?.get("feeCents") as? Number)?.toLong() ?: 0L,
        tipBasis = (raw?.get("tipBasis") as? String).orEmpty(),
        appliedCents = (raw?.get("appliedCents") as? Number)?.toLong() ?: 0L,
        unappliedCents = (raw?.get("unappliedCents") as? Number)?.toLong() ?: 0L,
        proceedsCents = (raw?.get("proceedsCents") as? Number)?.toLong() ?: 0L,
        tipNetCents = (raw?.get("tipNetCents") as? Number)?.toLong() ?: 0L,
        autoApply = raw?.get("autoApply") as? Boolean ?: false,
        application = contractRawMap(raw?.get("application"))?.let { nested -> decodeRecordPaymentResultApplication(nested) },
        creditedToAccountCents = (raw?.get("creditedToAccountCents") as? Number)?.toLong() ?: 0L,
        confirmationEmailSent = raw?.get("confirmationEmailSent") as? Boolean ?: false,
    )

// ---------- redeemCredit ----------

/** Request payload for the `redeemCredit` callable. */
data class RedeemCreditArgs(
    val invoiceId: String,
    /** Optional: omitted from the payload when null. */
    val kinfolkId: String? = null,
    /**
     * Always `accountBalance` on the wire.
     * The server defaults this to `"accountBalance"`.
     */
    val target: String = "accountBalance",
) {
    /**
     * The wire payload for this request, in the `recordPaymentPayload` convention:
     * a pure map, no Firebase types, so a test can assert it without static init.
     */
    fun toPayload(): Map<String, Any?> = buildMap<String, Any?> {
        put("invoiceId", invoiceId)
        if (kinfolkId != null) put("kinfolkId", kinfolkId)
        put("target", target)
    }
}

/** Response from the `redeemCredit` callable. */
data class RedeemCreditResult(
    val ok: Boolean,
    val redeemedAmountCents: Long,
    /** Always `accountBalance` on the wire. */
    val target: String,
    val newAccountBalanceCents: Long?,
)

/**
 * Fail-soft decode of `RedeemCreditResult` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeRedeemCreditResult(raw: Map<String, Any?>?): RedeemCreditResult =
    RedeemCreditResult(
        ok = raw?.get("ok") as? Boolean ?: false,
        redeemedAmountCents = (raw?.get("redeemedAmountCents") as? Number)?.toLong() ?: 0L,
        target = (raw?.get("target") as? String).orEmpty(),
        newAccountBalanceCents = (raw?.get("newAccountBalanceCents") as? Number)?.toLong(),
    )

// ---------- repairInvoicePayments ----------

/** Request payload for the `repairInvoicePayments` callable. */
data class RepairInvoicePaymentsArgs(
    /**
     * One of `detect`, `repair`.
     * The server defaults this to `"detect"`.
     */
    val mode: String = "detect",
    /** The server defaults this to `200L`. */
    val limit: Long = 200L,
    /** Optional: omitted from the payload when null. */
    val startAfterId: String? = null,
) {
    /**
     * The wire payload for this request, in the `recordPaymentPayload` convention:
     * a pure map, no Firebase types, so a test can assert it without static init.
     */
    fun toPayload(): Map<String, Any?> = buildMap<String, Any?> {
        put("mode", mode)
        put("limit", limit)
        if (startAfterId != null) put("startAfterId", startAfterId)
    }
}

/** Nested in the `repairInvoicePayments` contract. */
data class RepairInvoicePaymentsResultFinding(
    val invoiceId: String,
    val invoiceNumber: String?,
    val kinfolkId: String?,
    val totalCents: Long,
    val paidCents: Long,
    val claimedAmountDueCents: Long,
    val correctAmountDueCents: Long,
    val understatedCents: Long,
    val status: String,
)

/**
 * Fail-soft decode of `RepairInvoicePaymentsResultFinding` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeRepairInvoicePaymentsResultFinding(raw: Map<String, Any?>?): RepairInvoicePaymentsResultFinding =
    RepairInvoicePaymentsResultFinding(
        invoiceId = (raw?.get("invoiceId") as? String).orEmpty(),
        invoiceNumber = raw?.get("invoiceNumber") as? String,
        kinfolkId = raw?.get("kinfolkId") as? String,
        totalCents = (raw?.get("totalCents") as? Number)?.toLong() ?: 0L,
        paidCents = (raw?.get("paidCents") as? Number)?.toLong() ?: 0L,
        claimedAmountDueCents = (raw?.get("claimedAmountDueCents") as? Number)?.toLong() ?: 0L,
        correctAmountDueCents = (raw?.get("correctAmountDueCents") as? Number)?.toLong() ?: 0L,
        understatedCents = (raw?.get("understatedCents") as? Number)?.toLong() ?: 0L,
        status = (raw?.get("status") as? String).orEmpty(),
    )

/**
 * The `skipped` map of [RepairInvoicePaymentsResult].
 * Entries whose key or value is the wrong type are dropped, never defaulted.
 */
private fun decodeRepairInvoicePaymentsResultSkipped(value: Any?): Map<String, Long> =
    buildMap<String, Long> {
        (value as? Map<*, *>)?.forEach { (entryKey, entryValue) ->
            if (entryKey !is String) return@forEach
            val decoded = (entryValue as? Number)?.toLong() ?: return@forEach
            put(entryKey, decoded)
        }
    }

/** Response from the `repairInvoicePayments` callable. */
data class RepairInvoicePaymentsResult(
    val ok: Boolean,
    /** One of `detect`, `repair`. `""` when the payload omits it. */
    val mode: String,
    val scanned: Long,
    val findings: List<RepairInvoicePaymentsResultFinding>,
    val repaired: Long,
    /** Keys: `no_payments`, `payments_cover_total`, `no_total`, `balance_already_correct`, `would_lower_balance`. */
    val skipped: Map<String, Long>,
    val nextCursor: String?,
)

/**
 * Fail-soft decode of `RepairInvoicePaymentsResult` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeRepairInvoicePaymentsResult(raw: Map<String, Any?>?): RepairInvoicePaymentsResult =
    RepairInvoicePaymentsResult(
        ok = raw?.get("ok") as? Boolean ?: false,
        mode = (raw?.get("mode") as? String).orEmpty(),
        scanned = (raw?.get("scanned") as? Number)?.toLong() ?: 0L,
        findings = (raw?.get("findings") as? List<*>).orEmpty().mapNotNull { contractRawMap(it)?.let { nested -> decodeRepairInvoicePaymentsResultFinding(nested) } },
        repaired = (raw?.get("repaired") as? Number)?.toLong() ?: 0L,
        skipped = decodeRepairInvoicePaymentsResultSkipped(raw?.get("skipped")),
        nextCursor = raw?.get("nextCursor") as? String,
    )

// ---------- runAutoApply ----------

/** Request payload for the `runAutoApply` callable. */
data class RunAutoApplyArgs(
    val invoiceId: String,
) {
    /**
     * The wire payload for this request, in the `recordPaymentPayload` convention:
     * a pure map, no Firebase types, so a test can assert it without static init.
     */
    fun toPayload(): Map<String, Any?> = buildMap<String, Any?> {
        put("invoiceId", invoiceId)
    }
}

/** Response from the `runAutoApply` callable. */
data class RunAutoApplyResult(
    val ok: Boolean,
    val invoiceId: String,
    /** One of ``, `invoice_missing`, `invoice_not_collectable`, `no_household`, `no_credit`. `""` when the payload omits it. */
    val skipped: String,
    val appliedCents: Long,
    val amountDueCents: Long,
    val accountBalanceCents: Long,
)

/**
 * Fail-soft decode of `RunAutoApplyResult` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeRunAutoApplyResult(raw: Map<String, Any?>?): RunAutoApplyResult =
    RunAutoApplyResult(
        ok = raw?.get("ok") as? Boolean ?: false,
        invoiceId = (raw?.get("invoiceId") as? String).orEmpty(),
        skipped = (raw?.get("skipped") as? String).orEmpty(),
        appliedCents = (raw?.get("appliedCents") as? Number)?.toLong() ?: 0L,
        amountDueCents = (raw?.get("amountDueCents") as? Number)?.toLong() ?: 0L,
        accountBalanceCents = (raw?.get("accountBalanceCents") as? Number)?.toLong() ?: 0L,
    )

// ---------- resendQuote ----------

/** Request payload for the `resendQuote` callable. */
data class ResendQuoteArgs(
    val invoiceId: String,
) {
    /**
     * The wire payload for this request, in the `recordPaymentPayload` convention:
     * a pure map, no Firebase types, so a test can assert it without static init.
     */
    fun toPayload(): Map<String, Any?> = buildMap<String, Any?> {
        put("invoiceId", invoiceId)
    }
}

/** Response from the `resendQuote` callable. */
data class ResendQuoteResult(
    val ok: Boolean,
    val invoiceId: String,
    /** One of `quote`, `draft`, `cancelled`, `credit`, `redeemed`, `paid`, `zero`, `open`. `""` when the payload omits it. */
    val status: String,
)

/**
 * Fail-soft decode of `ResendQuoteResult` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeResendQuoteResult(raw: Map<String, Any?>?): ResendQuoteResult =
    ResendQuoteResult(
        ok = raw?.get("ok") as? Boolean ?: false,
        invoiceId = (raw?.get("invoiceId") as? String).orEmpty(),
        status = (raw?.get("status") as? String).orEmpty(),
    )

// ---------- reviewAndSendDraftInvoice ----------

/** Request payload for the `reviewAndSendDraftInvoice` callable. */
data class ReviewAndSendDraftInvoiceArgs(
    val invoiceId: String,
) {
    /**
     * The wire payload for this request, in the `recordPaymentPayload` convention:
     * a pure map, no Firebase types, so a test can assert it without static init.
     */
    fun toPayload(): Map<String, Any?> = buildMap<String, Any?> {
        put("invoiceId", invoiceId)
    }
}

/** Response from the `reviewAndSendDraftInvoice` callable. */
data class ReviewAndSendDraftInvoiceResult(
    val ok: Boolean,
    val invoiceId: String,
)

/**
 * Fail-soft decode of `ReviewAndSendDraftInvoiceResult` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeReviewAndSendDraftInvoiceResult(raw: Map<String, Any?>?): ReviewAndSendDraftInvoiceResult =
    ReviewAndSendDraftInvoiceResult(
        ok = raw?.get("ok") as? Boolean ?: false,
        invoiceId = (raw?.get("invoiceId") as? String).orEmpty(),
    )

// ---------- sendInvoiceReminder ----------

/** Request payload for the `sendInvoiceReminder` callable. */
data class SendInvoiceReminderArgs(
    val invoiceId: String,
) {
    /**
     * The wire payload for this request, in the `recordPaymentPayload` convention:
     * a pure map, no Firebase types, so a test can assert it without static init.
     */
    fun toPayload(): Map<String, Any?> = buildMap<String, Any?> {
        put("invoiceId", invoiceId)
    }
}

/** Response from the `sendInvoiceReminder` callable. */
data class SendInvoiceReminderResult(
    val ok: Boolean,
    val invoiceId: String,
    val sent: Boolean,
    /** One of `sent`, `recent`, `in-progress`, `suppressed`. `""` when the payload omits it. */
    val reason: String,
    val lastReminderAtMs: Long?,
    val nextReminderAllowedAtMs: Long?,
)

/**
 * Fail-soft decode of `SendInvoiceReminderResult` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeSendInvoiceReminderResult(raw: Map<String, Any?>?): SendInvoiceReminderResult =
    SendInvoiceReminderResult(
        ok = raw?.get("ok") as? Boolean ?: false,
        invoiceId = (raw?.get("invoiceId") as? String).orEmpty(),
        sent = raw?.get("sent") as? Boolean ?: false,
        reason = (raw?.get("reason") as? String).orEmpty(),
        lastReminderAtMs = (raw?.get("lastReminderAtMs") as? Number)?.toLong(),
        nextReminderAllowedAtMs = (raw?.get("nextReminderAllowedAtMs") as? Number)?.toLong(),
    )

// ---------- unarchiveInvoice ----------

/** Request payload for the `unarchiveInvoice` callable. */
data class UnarchiveInvoiceArgs(
    val invoiceId: String,
) {
    /**
     * The wire payload for this request, in the `recordPaymentPayload` convention:
     * a pure map, no Firebase types, so a test can assert it without static init.
     */
    fun toPayload(): Map<String, Any?> = buildMap<String, Any?> {
        put("invoiceId", invoiceId)
    }
}

/** Response from the `unarchiveInvoice` callable. */
data class UnarchiveInvoiceResult(
    val ok: Boolean,
    val invoiceId: String,
)

/**
 * Fail-soft decode of `UnarchiveInvoiceResult` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeUnarchiveInvoiceResult(raw: Map<String, Any?>?): UnarchiveInvoiceResult =
    UnarchiveInvoiceResult(
        ok = raw?.get("ok") as? Boolean ?: false,
        invoiceId = (raw?.get("invoiceId") as? String).orEmpty(),
    )

// ---------- updateInvoice ----------

/** Nested in the `updateInvoice` contract. */
data class UpdateInvoiceArgsPatchLineItem(
    val description: String,
    val qty: Double,
    val unitCents: Long,
    /** Optional: omitted from the payload when null. */
    val discountCents: Long? = null,
    /** Optional: omitted from the payload when null. */
    val sessionId: String? = null,
) {
    /**
     * The wire payload for this request, in the `recordPaymentPayload` convention:
     * a pure map, no Firebase types, so a test can assert it without static init.
     */
    fun toPayload(): Map<String, Any?> = buildMap<String, Any?> {
        put("description", description)
        put("qty", qty)
        put("unitCents", unitCents)
        if (discountCents != null) put("discountCents", discountCents)
        if (sessionId != null) put("sessionId", sessionId)
    }
}

/**
 * Nested in the `updateInvoice` contract.
 * The server also enforces a cross-field rule this class cannot express (zod .refine);
 * a payload that satisfies these types can still be refused.
 */
data class UpdateInvoiceArgsPatch(
    /** Optional: omitted from the payload when null. */
    val invoiceNumber: String? = null,
    /** Optional: omitted from the payload when null. */
    val date: String? = null,
    /** Optional: omitted from the payload when null. */
    val dueDate: String? = null,
    /** Optional: omitted from the payload when null. */
    val terms: String? = null,
    /**
     * One of `due_on_receipt`, `net_7`, `net_14`, `net_30`, `due_on_last_visit`, `net_7_after_last_visit`, `net_14_after_last_visit`, `custom`.
     * Optional: omitted from the payload when null.
     */
    val termsCode: String? = null,
    /** Optional: omitted from the payload when null. */
    val kinfolkName: String? = null,
    /** Optional: omitted from the payload when null. */
    val client: String? = null,
    /** Optional: omitted from the payload when null. */
    val address: String? = null,
    /** Optional: omitted from the payload when null. */
    val discount: String? = null,
    /** Optional: omitted from the payload when null. */
    val lineItems: List<UpdateInvoiceArgsPatchLineItem>? = null,
    /** Optional: omitted from the payload when null. */
    val invoiceDiscountCents: Long? = null,
) {
    /**
     * The wire payload for this request, in the `recordPaymentPayload` convention:
     * a pure map, no Firebase types, so a test can assert it without static init.
     */
    fun toPayload(): Map<String, Any?> = buildMap<String, Any?> {
        if (invoiceNumber != null) put("invoiceNumber", invoiceNumber)
        if (date != null) put("date", date)
        if (dueDate != null) put("dueDate", dueDate)
        if (terms != null) put("terms", terms)
        if (termsCode != null) put("termsCode", termsCode)
        if (kinfolkName != null) put("kinfolkName", kinfolkName)
        if (client != null) put("client", client)
        if (address != null) put("address", address)
        if (discount != null) put("discount", discount)
        if (lineItems != null) put("lineItems", lineItems.map { it.toPayload() })
        if (invoiceDiscountCents != null) put("invoiceDiscountCents", invoiceDiscountCents)
    }
}

/** Request payload for the `updateInvoice` callable. */
data class UpdateInvoiceArgs(
    val invoiceId: String,
    val patch: UpdateInvoiceArgsPatch,
) {
    /**
     * The wire payload for this request, in the `recordPaymentPayload` convention:
     * a pure map, no Firebase types, so a test can assert it without static init.
     */
    fun toPayload(): Map<String, Any?> = buildMap<String, Any?> {
        put("invoiceId", invoiceId)
        put("patch", patch.toPayload())
    }
}

/** Nested in the `updateInvoice` contract. */
data class UpdateInvoiceResultTotals(
    val subtotalCents: Long,
    val totalCents: Long,
    val paidCents: Long,
    val amountDueCents: Long,
)

/**
 * Fail-soft decode of `UpdateInvoiceResultTotals` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeUpdateInvoiceResultTotals(raw: Map<String, Any?>?): UpdateInvoiceResultTotals =
    UpdateInvoiceResultTotals(
        subtotalCents = (raw?.get("subtotalCents") as? Number)?.toLong() ?: 0L,
        totalCents = (raw?.get("totalCents") as? Number)?.toLong() ?: 0L,
        paidCents = (raw?.get("paidCents") as? Number)?.toLong() ?: 0L,
        amountDueCents = (raw?.get("amountDueCents") as? Number)?.toLong() ?: 0L,
    )

/** Response from the `updateInvoice` callable. */
data class UpdateInvoiceResult(
    val ok: Boolean,
    val invoiceId: String,
    val totals: UpdateInvoiceResultTotals,
)

/**
 * Fail-soft decode of `UpdateInvoiceResult` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeUpdateInvoiceResult(raw: Map<String, Any?>?): UpdateInvoiceResult =
    UpdateInvoiceResult(
        ok = raw?.get("ok") as? Boolean ?: false,
        invoiceId = (raw?.get("invoiceId") as? String).orEmpty(),
        totals = decodeUpdateInvoiceResultTotals(contractRawMap(raw?.get("totals"))),
    )
