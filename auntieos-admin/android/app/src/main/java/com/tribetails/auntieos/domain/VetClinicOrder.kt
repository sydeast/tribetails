package com.tribetails.auntieos.domain
import com.tribetails.auntieos.data.model.VetClinic
/**
 * A to Z by clinic name, then document id (#1565).
 *
 * The `vet_clinics` listener pages by document id rather than `orderBy("name")`:
 * Firestore drops a document that lacks the ordered field, so a clinic saved
 * without a name would vanish from the bank and every picker. The display order
 * is rebuilt here instead, and a clinic with no name sorts first rather than
 * disappearing. Mirrors the web `sortVetClinics`.
 */
fun sortVetClinics(clinics: List<VetClinic>): List<VetClinic> =
    clinics.sortedWith(compareBy({ it.name.trim().lowercase() }, { it.id }))
