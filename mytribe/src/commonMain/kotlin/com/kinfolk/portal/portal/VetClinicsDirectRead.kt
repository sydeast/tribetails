package com.kinfolk.portal.portal
import com.kinfolk.portal.firebase.FirestoreClient
/**
 * #1503: the shared `vet_clinics` catalog, read straight from Firestore
 * instead of through the `getVetClinics` callable.
 *
 * `getVetClinics` carries no `minInstances`, so Tribe Profile waited on a
 * Cloud Run cold start to fill its clinic picker. `mytribe/firestore.rules`
 * already grants the read: `match /vet_clinics/{clinicId}` allows
 * `read: if signedIn()`. The rule does not hide pending or archived rows, so
 * THIS CLIENT APPLIES THE CALLABLE'S FILTER: a nameless row, an explicit
 * `verified == false` submission and an `archived == true` clinic are dropped;
 * a missing `verified` or `archived` flag reads as approved and active (legacy
 * rows predate both). The filter is a presentation rule, not a security
 * boundary: the rule already exposed those rows to any signed-in user.
 *
 * The mapping is a field-for-field copy of `functions/src/portal/getVetClinics.ts`
 * and of the web portal's `lib/vetClinicsDirectRead.ts`.
 */
private fun str(v: Any?): String = v as? String ?: ""
/** One `vet_clinics/{id}` document as the portal's [VetClinic], or null when the portal hides it. */
fun vetClinicFromDocument(id: String, fields: Map<String, Any?>): VetClinic? {
    if (str(fields["name"]).isEmpty() || fields["verified"] == false || fields["archived"] == true) return null
    return VetClinic(
        id = id,
        name = str(fields["name"]),
        phone = str(fields["phone"]),
        address = str(fields["address"]),
        website = str(fields["website"]),
        googleMapsUrl = str(fields["googleMapsUrl"]),
        isEmergency = fields["isEmergency"] == true,
    )
}
/** Reads the approved catalog. Throws whatever the client throws; the caller decides the fallback. */
suspend fun readVetClinicsDirect(firestore: FirestoreClient): List<VetClinic> =
    firestore.listDocuments("vet_clinics").mapNotNull { vetClinicFromDocument(it.id, it.fields) }
