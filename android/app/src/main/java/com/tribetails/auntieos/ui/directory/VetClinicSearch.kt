package com.tribetails.auntieos.ui.directory

import com.tribetails.auntieos.data.model.VetClinic

/**
 * Pure filter for the vet-clinic search box. Prefix matches rank first, then substring
 * matches, capped at [limit] so a 100+ clinic catalog stays a short, scannable dropdown.
 * A blank query returns nothing: the box is a search field, not a full-catalog dump.
 * Mirrors the web helper of the same name.
 */
fun vetClinicSuggestions(query: String, clinics: List<VetClinic>, limit: Int = 8): List<VetClinic> {
    val q = query.trim().lowercase()
    if (q.isEmpty()) return emptyList()
    val starts = clinics.filter { it.name.lowercase().startsWith(q) }
    val contains = clinics.filter { !it.name.lowercase().startsWith(q) && it.name.lowercase().contains(q) }
    return (starts + contains).take(limit)
}
