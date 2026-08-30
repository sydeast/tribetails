package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.model.PortalHomeSection

/**
 * ISSUE #397 M10: pure, Compose-free helpers for the operator-editable
 * kinfolk portal Home layout (`HomeLayoutPanel` in AdminSettingsScreen.kt).
 *
 * [HOME_SECTION_CATALOG] is one of THREE independent copies of the same fixed
 * id list — the other two are `CANONICAL_HOME_ORDER` in
 * `mytribe/web/src/lib/portalFormat.ts` and HomeScreen.kt's own
 * `CANONICAL_HOME_ORDER` — because none of the three clients share a source
 * tree. This file is presentation-only for the ADMIN editor: it names and
 * orders the rows an operator can toggle/limit/reorder, but the PORTAL is what
 * actually decides how `sections` renders, and this list must stay in step
 * with that decision, not the other way round.
 */

/** One catalogue entry: a fixed section [id] and its operator-facing [label]. */
data class HomeSectionOption(val id: String, val label: String)

val HOME_SECTION_CATALOG: List<HomeSectionOption> = listOf(
    HomeSectionOption("liveVisit", "Live visit"),
    HomeSectionOption("upNext", "Up next"),
    HomeSectionOption("tales", "Recent KinTales"),
    HomeSectionOption("roster", "Tribe roster"),
    HomeSectionOption("quickStart", "Quick start"),
)

/** The operator-facing name for a section id, or the raw id for one this catalogue doesn't know (a legacy or future row must still be nameable, never hidden). */
fun homeSectionLabel(id: String): String =
    HOME_SECTION_CATALOG.firstOrNull { it.id == id }?.label ?: id.ifBlank { "Unnamed section" }

/**
 * The rows the Home layout editor renders, derived from [stored] without
 * mutating it. One-for-one port of `effectiveHomeSections` in the React admin
 * (`auntieos-admin/src/lib/settingsFormat.ts`) — see that function's comment
 * for the two-branch rationale: an EMPTY list is the portal's "no config at
 * all" default (canonical order, everything on, unlimited); a NON-empty list
 * is a curated subset, and any catalogue id it omits is appended here,
 * disabled, so it stays reachable rather than silently unreachable from this
 * client.
 */
fun effectiveHomeSections(stored: List<PortalHomeSection>): List<PortalHomeSection> {
    if (stored.isEmpty()) {
        return HOME_SECTION_CATALOG.map { PortalHomeSection(id = it.id, enabled = true, limit = 0) }
    }
    val present = stored.map { it.id }.toSet()
    val missing = HOME_SECTION_CATALOG
        .filter { it.id !in present }
        .map { PortalHomeSection(id = it.id, enabled = false, limit = 0) }
    return stored + missing
}

/** Reorders one step earlier. No-op at the top or out of range. */
fun moveHomeSectionUp(list: List<PortalHomeSection>, index: Int): List<PortalHomeSection> {
    if (index <= 0 || index >= list.size) return list
    val out = list.toMutableList()
    out[index - 1] = list[index]; out[index] = list[index - 1]
    return out
}

/** Reorders one step later. No-op at the bottom or out of range. */
fun moveHomeSectionDown(list: List<PortalHomeSection>, index: Int): List<PortalHomeSection> {
    if (index < 0 || index >= list.size - 1) return list
    val out = list.toMutableList()
    out[index + 1] = list[index]; out[index] = list[index + 1]
    return out
}

/** Replaces the row at [index] with [value]. Bounds-checked so a stale index from a race is a no-op, never a crash. */
fun List<PortalHomeSection>.replacedAt(index: Int, value: PortalHomeSection): List<PortalHomeSection> {
    if (index < 0 || index >= size) return this
    return toMutableList().also { it[index] = value }
}

/**
 * ISSUE #397 M10 FOLLOW-UP: the one-way-door guard, mirroring
 * `homeLayoutModeLabel` / `RESET_HOME_SECTIONS` in the React admin
 * (`auntieos-admin/src/lib/settingsFormat.ts`).
 *
 * "Default layout" (an empty [sections], the portal's own implicit default)
 * or "Custom layout" (an explicit array is saved, however close its contents
 * are to canonical). The operator must be able to tell these apart by
 * looking, not by inferring it from whether every toggle happens to read on.
 */
fun homeLayoutModeLabel(sections: List<PortalHomeSection>): String =
    if (sections.isEmpty()) "Default layout" else "Custom layout"

/**
 * The value "Reset to default layout" writes: the empty list the portal (on
 * both clients) reads as "no config at all" -- canonical order, every
 * section shown, unlimited. A reset writes this literal empty list rather
 * than a full canonical list that merely LOOKS like the default, so the
 * document goes back to genuinely unconfigured rather than to a custom
 * config that happens to match today's defaults.
 */
val RESET_HOME_SECTIONS: List<PortalHomeSection> = emptyList()
