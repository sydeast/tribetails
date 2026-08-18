package com.kinfolk.portal.portal

data class KinPayload(
    val name: String,
    val species: String? = null,
    val breed: String? = null,
    val ageYears: Double? = null,
    val photoUrl: String? = null,
    val feedingInstructions: String? = null,
    val walkingInstructions: String? = null,
    val medications: String? = null,
    val allergies: String? = null,
    val emergencyNotes: String? = null,
    val sitterNotes: String? = null,
    val legacyKinId: String? = null,
)

data class PayInvoiceResult(
    val checkoutUrl: String,
    val sessionId: String,
    val amountCents: Long,
    val currency: String,
)

/**
 * The household's card on file (#399 item 3, `portal/billing.ts`).
 *
 * [card] is null both when there is no card AND when the server holds one it
 * could not describe, which is why [hasPaymentMethod] is a separate flag: the
 * screen renders the generic "on file" line in the second case rather than a
 * half-empty card.
 */
data class PaymentMethodState(
    val hasPaymentMethod: Boolean,
    val card: SavedCard?,
    val updatedAtMs: Long?,
)
data class SavedCard(
    /** Stripe's brand string, lowercase: "visa", "mastercard", "amex". */
    val brand: String,
    val last4: String,
    val expMonth: Int,
    val expYear: Int,
) {
    /** "Visa •••• 4242 · exp 04/2030". */
    fun display(): String =
        "${brand.replaceFirstChar { it.uppercase() }} •••• $last4 · exp ${expMonth.toString().padStart(2, '0')}/$expYear"
}
data class BillingSetupSession(
    val checkoutUrl: String,
    val sessionId: String,
)
data class KinTaleMedia(
    val id: String,
    val url: String,
    val contentType: String?,
    val expiresAtMs: Long,
)
