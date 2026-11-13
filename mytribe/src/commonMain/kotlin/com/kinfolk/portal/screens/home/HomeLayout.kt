package com.kinfolk.portal.screens.home

import com.kinfolk.portal.portal.PortalHomeSection

/**
 * The pure half of Home's operator-configured layout, out of HomeScreen.kt so
 * `commonTest` can reach it. One-for-one with `resolveHomeLayout` and
 * `homeLayoutMode` in the web portal (`mytribe/web/src/lib/portalFormat.ts`):
 * the same operator config has to produce the same page on both clients.
 */

/** A resolved home section: id + per-section limit (0 = unlimited). */
internal data class HomeSectionResolved(val id: String, val limit: Int)

/** Canonical section order used when the operator supplies no config. */
internal val CANONICAL_HOME_ORDER = listOf("liveVisit", "upNext", "tales", "roster", "quickStart")

/** The sections Home can draw. `roster` is in the canonical order for old configs but has had no card since #1412. */
private val DRAWN_HOME_ORDER = listOf("liveVisit", "upNext", "tales", "quickStart")

/**
 * Resolves the home layout from the operator [sections] config. Empty config →
 * the canonical order with all sections enabled. Otherwise: the configured
 * order, dropping `enabled == false` and any unknown ids, carrying each
 * section's limit through.
 */
internal fun resolveHomeLayout(sections: List<PortalHomeSection>): List<HomeSectionResolved> {
    if (sections.isEmpty()) return CANONICAL_HOME_ORDER.map { HomeSectionResolved(it, 0) }
    return sections
        .filter { it.enabled && it.id in CANONICAL_HOME_ORDER }
        .map { HomeSectionResolved(it.id, it.limit) }
}

/** The two page shapes Home takes. See [homeLayoutMode]. */
internal enum class HomeLayoutMode { Columns, Stacked }

/**
 * #1987: which page shape Home takes. [HomeLayoutMode.Columns] is the standard
 * page (Quick start beside Up next and Recent KinTales on a wide screen, above
 * them on a phone); [HomeLayoutMode.Stacked] is one column in the operator's
 * own order.
 *
 * ORDER is the only thing that chooses. The page is stacked when the operator
 * has moved a section out of the standard order, because a custom order cannot
 * be forced into two fixed columns. A Limit only caps how many rows a card
 * lists and a switch only hides a card, so neither is read here: before this,
 * any saved list at all (one Limit of 2, or four rows equal to the default)
 * flipped every household's Home to the stacked page.
 *
 * Two cases have nothing to put side by side, so they are stacked too, in the
 * same order the columns would have read on a phone: Quick start switched off,
 * or both Up next and Recent KinTales switched off.
 */
internal fun homeLayoutMode(sections: List<PortalHomeSection>): HomeLayoutMode {
    val shown = resolveHomeLayout(sections).map { DRAWN_HOME_ORDER.indexOf(it.id) }.filter { it >= 0 }
    val standardOrder = shown.zipWithNext().all { (before, after) -> after > before }
    if (!standardOrder) return HomeLayoutMode.Stacked
    fun has(id: String) = DRAWN_HOME_ORDER.indexOf(id) in shown
    return if (has("quickStart") && (has("upNext") || has("tales"))) HomeLayoutMode.Columns else HomeLayoutMode.Stacked
}
