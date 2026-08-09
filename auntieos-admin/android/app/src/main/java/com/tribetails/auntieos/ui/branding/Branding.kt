package com.tribetails.auntieos.ui.branding

import com.tribetails.auntieos.data.model.BusinessSettings

/**
 * 17.2 Branding pure helpers (android). Resolve the operator-editable brand fields
 * on [BusinessSettings] into display values, with blank-safe fallbacks to the
 * shipped defaults so a never-customized install reads byte-identical to pre-17.2.
 * Free of Compose + the clock so they are JVM-unit-testable. Mirror of the web
 * branding/Branding.kt. See [com.tribetails.auntieos.ui.branding.BrandingTest].
 */

/** Resolved Home heading: salutation [title] + italic brand [accentTail]. */
data class HomeHeading(val title: String, val accentTail: String)

/** Resolved brand block: [logoUrl] (blank -> caller's glyph fallback), [wordmark], [tagline]. */
data class BrandIdentity(val logoUrl: String, val wordmark: String, val tagline: String)

const val DEFAULT_BRAND_WORDMARK = "AuntieOS"
const val DEFAULT_BRAND_TAGLINE = "Tribe Tails Care"
const val DEFAULT_HOME_ACCENT_TAIL = "Auntie."

private val TRAILING_PUNCTUATION = setOf(',', '.', '!', '?', ':', ';')

/**
 * The Home heading. Uses [BusinessSettings.homeGreeting] when set, else the
 * time-aware [defaultGreeting] (the caller resolves the clock). A trailing comma is
 * appended unless the text already ends in punctuation, so the default
 * ("Good Morning,") matches the old hardcoded heading exactly while a custom
 * "Hello!" is not mangled into "Hello!,".
 */
fun homeHeading(settings: BusinessSettings, defaultGreeting: String): HomeHeading {
    val base = settings.homeGreeting.trim().ifBlank { defaultGreeting.trim() }
    val title = when {
        base.isEmpty() -> ""
        base.last() in TRAILING_PUNCTUATION -> base
        else -> "$base,"
    }
    val tail = settings.homeAccentTail.trim().ifBlank { DEFAULT_HOME_ACCENT_TAIL }
    return HomeHeading(title = title, accentTail = tail)
}

/** Brand identity with blank-safe fallbacks to the shipped defaults. */
fun brandIdentity(settings: BusinessSettings): BrandIdentity = BrandIdentity(
    logoUrl = settings.logoUrl.trim(),
    wordmark = settings.brandWordmark.trim().ifBlank { DEFAULT_BRAND_WORDMARK },
    tagline = settings.brandTagline.trim().ifBlank { DEFAULT_BRAND_TAGLINE },
)

/**
 * Settings copy carrying the edited branding fields (trimmed), ready to be
 * diffed against the loaded document by `AdminSettingsViewModel.saveBranding`.
 *
 * Only the five branding fields change here; every sibling is carried through
 * untouched. That used to be the whole defence and it was not enough - the write
 * then sent the carried siblings as well, at whatever values the phone had read
 * minutes earlier. `BusinessSettingsDiff.kt` is what turns "unchanged in memory"
 * into "absent from the write".
 */
fun BusinessSettings.withBranding(
    logoUrl: String,
    wordmark: String,
    tagline: String,
    greeting: String,
    accentTail: String,
    logoRemovedAt: String = this.logoRemovedAt,
): BusinessSettings = copy(
    logoUrl = logoUrl.trim(),
    logoRemovedAt = logoRemovedAt,
    brandWordmark = wordmark.trim(),
    brandTagline = tagline.trim(),
    homeGreeting = greeting.trim(),
    homeAccentTail = accentTail.trim(),
)

/** The three states a logo slot can be in. Two of them are both `logoUrl == ""`. */
enum class LogoState { SET, REMOVED, NEVER_SET }

/**
 * Which of the three states to show. REMOVED and NEVER_SET are distinguished
 * ONLY by [logoRemovedAt]; collapsing them would leave an operator who just
 * pressed Remove looking at the same panel a fresh install shows, with no
 * confirmation the removal landed. Mirrors `logoStateLabel` in the React admin
 * (`src/lib/settingsFormat.ts`).
 */
fun logoState(logoUrl: String, logoRemovedAt: String): LogoState = when {
    logoUrl.isNotBlank() -> LogoState.SET
    logoRemovedAt.isNotBlank() -> LogoState.REMOVED
    else -> LogoState.NEVER_SET
}

/**
 * The `logoRemovedAt` stamp a branding save should carry, given what was loaded
 * and what is about to be written. Pure, and the clock is the caller's, so it is
 * unit-testable.
 *
 * Three cases, and the middle one is the reason this is a function rather than a
 * ternary at the call site: a save that leaves an ALREADY-blank logo blank must
 * NOT restamp, or every unrelated text edit would keep moving the removal date
 * forward and the operator could never tell when the logo actually went.
 */
fun nextLogoRemovedAt(
    previousLogoUrl: String,
    previousRemovedAt: String,
    nextLogoUrl: String,
    nowIso: String,
): String = when {
    nextLogoUrl.isNotBlank() -> ""                                   // a logo is set: nothing was removed
    previousLogoUrl.isNotBlank() -> nowIso                           // this save is the removal
    else -> previousRemovedAt                                        // already blank: leave the record alone
}

/** True when any of the five branding fields differ (Save-bar enablement). */
fun brandingDirty(loaded: BusinessSettings, edited: BusinessSettings): Boolean =
    loaded.logoUrl != edited.logoUrl ||
        loaded.brandWordmark != edited.brandWordmark ||
        loaded.brandTagline != edited.brandTagline ||
        loaded.homeGreeting != edited.homeGreeting ||
        loaded.homeAccentTail != edited.homeAccentTail
