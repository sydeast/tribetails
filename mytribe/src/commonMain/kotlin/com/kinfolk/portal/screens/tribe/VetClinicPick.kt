package com.kinfolk.portal.screens.tribe
import com.kinfolk.portal.portal.VetClinic
import com.kinfolk.portal.util.formatPhone
/**
 * Pure helpers for the Tribe Profile Vet Clinic card (#1378). The card picks a
 * catalog clinic by id, like portal web; nothing here touches the network.
 */
/** Clinics whose name contains [query] (case-insensitive), at most [limit], in catalog order. Blank query matches nothing. */
internal fun vetClinicMatches(query: String, clinics: List<VetClinic>, limit: Int = 8): List<VetClinic> {
    val q = query.trim()
    if (q.isEmpty()) return emptyList()
    return clinics.filter { it.name.contains(q, ignoreCase = true) }.take(limit)
}
/**
 * The clinic to show as "Clinic on file" for the linked [clinicId]: the catalog
 * row when it lists it, else the clinic picked or added this session (an
 * unapproved submission is not in the catalog). Null when nothing is linked or
 * the id no longer resolves.
 */
internal fun clinicOnFile(clinicId: String, catalog: List<VetClinic>, picked: VetClinic?): VetClinic? {
    val id = clinicId.trim()
    if (id.isEmpty()) return null
    return catalog.firstOrNull { it.id == id } ?: picked?.takeIf { it.id == id }
}
internal fun clinicTitle(name: String, isEmergency: Boolean): String =
    if (isEmergency) "$name · 24hr" else name
/** "(805) 555-0170 · 12 Ridge Rd": the phone formatted by [formatPhone], then the address, blanks dropped. */
internal fun clinicDetailLine(phone: String, address: String): String =
    listOf(formatPhone(phone), address.trim()).filter { it.isNotBlank() }.joinToString(" · ")
