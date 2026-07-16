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

data class KinTaleMedia(
    val id: String,
    val url: String,
    val contentType: String?,
    val expiresAtMs: Long,
)
