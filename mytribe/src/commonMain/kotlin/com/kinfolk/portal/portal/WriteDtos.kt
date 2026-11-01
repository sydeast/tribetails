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
    // The five facts shared with the admin (#1310). Text: null leaves the stored
    // value alone, "" clears it (the server rejects null; the admin Android model
    // decodes these as non-null). Flag: null leaves it alone.
    val sex: String? = null,
    val weight: String? = null,
    val colorMarkings: String? = null,
    val spayedNeutered: Boolean? = null,
    val vetInfo: String? = null,
    /**
     * #1336. Keys of the nullable fields above to send as an explicit JSON
     * `null`, which `updateKin` stores as a clear. A null property alone means
     * "leave the stored value alone" and is omitted. Only keys in
     * [NULL_CLEARABLE_KIN_FIELDS] are honoured; the five shared facts clear
     * with "" instead.
     */
    val clearFields: Set<String> = emptySet(),
)

/**
 * #1336. The [KinPayload] fields whose clear value is JSON `null` (the
 * server's zod marks them `.nullable()`; CALLABLE_CONTRACT.md "Clearing a
 * field"). The kin dialog clears a photo through its own path (#1291).
 */
val NULL_CLEARABLE_KIN_FIELDS: Set<String> = setOf(
    "species",
    "breed",
    "ageYears",
    "photoUrl",
    "feedingInstructions",
    "walkingInstructions",
    "medications",
    "allergies",
    "emergencyNotes",
    "sitterNotes",
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
