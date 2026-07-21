package com.tribetails.auntieos.web.branding

import com.tribetails.auntieos.web.data.BusinessSettings

/**
 * 17.2 Branding pure helpers (web/desktop). Resolve the operator-editable brand
 * fields on [BusinessSettings] into display values, with blank-safe fallbacks to
 * the shipped defaults so a never-customized install reads byte-identical to
 * pre-17.2. Kept free of Compose + the clock so they are unit-testable on the JVM
 * (mirrored verbatim on android). See [BrandingTest].
 */

/** Resolved Home heading: salutation [title] + italic brand [accentTail]. */
data class HomeHeading(val title: String, val accentTail: String)

/** Resolved nav-rail brand block: [logoUrl] (blank -> caller's glyph fallback), [wordmark], [tagline]. */
data class BrandIdentity(val logoUrl: String, val wordmark: String, val tagline: String)

const val DEFAULT_BRAND_WORDMARK = "AuntieOS"
const val DEFAULT_BRAND_TAGLINE = "Tribe Tails Care"
const val DEFAULT_HOME_ACCENT_TAIL = "Auntie."

private val TRAILING_PUNCTUATION = setOf(',', '.', '!', '?', ':', ';')

/**
 * The Home heading. Uses [BusinessSettings.homeGreeting] when set, else the
 * time-aware [defaultGreeting] (the caller resolves the clock, keeping this pure).
 * A trailing comma is appended unless the text already ends in punctuation, so
 * the default ("Good Morning,") matches the old hardcoded heading exactly while a
 * custom "Hello!" is not mangled into "Hello!,".
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
 * Settings copy carrying the edited branding fields (trimmed), ready for
 * saveBusinessSettings. Only the five branding fields change; every sibling field
 * is preserved so the merge write never clobbers unrelated config.
 */
fun BusinessSettings.withBranding(
    logoUrl: String,
    wordmark: String,
    tagline: String,
    greeting: String,
    accentTail: String,
): BusinessSettings = copy(
    logoUrl = logoUrl.trim(),
    brandWordmark = wordmark.trim(),
    brandTagline = tagline.trim(),
    homeGreeting = greeting.trim(),
    homeAccentTail = accentTail.trim(),
)

/** True when any of the five branding fields differ (Save-bar enablement). */
fun brandingDirty(loaded: BusinessSettings, edited: BusinessSettings): Boolean =
    loaded.logoUrl != edited.logoUrl ||
        loaded.brandWordmark != edited.brandWordmark ||
        loaded.brandTagline != edited.brandTagline ||
        loaded.homeGreeting != edited.homeGreeting ||
        loaded.homeAccentTail != edited.homeAccentTail
