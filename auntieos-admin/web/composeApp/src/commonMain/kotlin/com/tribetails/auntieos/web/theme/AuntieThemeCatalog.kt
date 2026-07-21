package com.tribetails.auntieos.web.theme

import androidx.compose.ui.graphics.Color

/**
 * The nine named theme presets shared, by intent, with the MyTribe portal's
 * `PortalThemeCatalog` (plan Task 4.1). Each preset maps a Tribe Tails brand
 * "trend" to a concrete set of [AuntieColors] token overlays over the shipped
 * light/dark base. This drives AuntieOS's OWN staff-UI Appearance theming and is
 * entirely separate from the portal's `mytribePortal.themeId` (which the MyTribe
 * app resolves with its own catalog).
 *
 * Design rules (mirrors the portal catalog):
 *  - `default` applies no overlay (byte-identical to today's light/dark base).
 *  - Every preset keeps one dominant hue + one sharp accent so the look stays
 *    legible (no raw-hex picking, always a tested set).
 *  - `isDark` flips the whole Material/Auntie scheme (only `midnight` here).
 *  - A preset is resolved over the CURRENT mode base, so a light-mode operator
 *    and a dark-mode operator both get a sensible variant unless the preset is
 *    intrinsically dark (`midnight`), which forces dark.
 *
 * The colors are brand-derived: KinfolkOrange, PackPink, KinTeal, FamilyPurple,
 * SnuggleCoral, BrandCream, BrandNavy (see [AuntieColors]).
 */
enum class AuntieThemePreset(
    val key: String,
    val label: String,
    /** One-line description of the trend, shown under the swatch card. */
    val blurb: String,
    /** Intrinsically dark preset (forces the dark scheme regardless of mode). */
    val forcesDark: Boolean = false,
) {
    DEFAULT("default", "Default", "Cream + Navy with the Orange brand primary."),
    MIDNIGHT("midnight", "Midnight", "Dark base, vibrant Orange + Pink accents.", forcesDark = true),
    CLEAR("clear", "Clear", "High-contrast white + Navy for accessibility."),
    SUNSET("sunset", "Sunset", "Warm gradient leanings, Orange to Pink."),
    DUO("duo", "Duotone", "Navy + Orange two-tone, minimal third hue."),
    CALM("calm", "Calm", "Minimalist neutral with a single Teal accent."),
    HEARTH("hearth", "Hearth", "Warm beige + Orange with an earthy Teal."),
    JEWEL("jewel", "Jewel", "Rich Purple + sapphire Teal jewel tones."),
    SOFT("soft", "Soft", "Washed Pink + lavender soft-tech pastels.");

    companion object {
        val DEFAULT_PRESET = DEFAULT

        /** Parse a stored key, fail-safe to [DEFAULT_PRESET] (matches AccentChoice.parse). */
        fun parse(stored: String?): AuntieThemePreset =
            entries.firstOrNull { it.key.equals(stored?.trim(), ignoreCase = true) } ?: DEFAULT_PRESET
    }
}

/**
 * The swatch pair shown on a preset card: [dominant] is the surface/background
 * feel, [accent] is the sharp brand accent. Pure data so the picker card is a
 * thin renderer over the catalog.
 */
data class AuntieThemeSwatch(val dominant: Color, val accent: Color)

/** The two swatch colors for a preset, resolved against [isDark] for legible cards. */
fun AuntieThemePreset.swatch(isDark: Boolean): AuntieThemeSwatch {
    // Resolve the same colors the preset will actually apply, then surface the
    // dominant (background) + the primary accent for the card.
    val resolved = auntiePresetColors(this, isDark)
    return AuntieThemeSwatch(dominant = resolved.background, accent = resolved.primary)
}

/**
 * Resolve a preset to a full [AuntieColors] set, overlaid on the shipped base for
 * [isDark] (or the preset's intrinsic dark base when it [forcesDark]).
 * Unknown/`default` -> the untouched base, so a never-customized install reads
 * byte-identical to today.
 *
 * Catalog signature mirrors the portal's `portalColors(themeId): Pair<colors, isDark>`.
 */
fun auntiePresetColors(preset: AuntieThemePreset, isDark: Boolean): AuntieColors {
    val effectiveDark = isDark || preset.forcesDark
    val base = if (effectiveDark) DarkAuntieColors else LightAuntieColors
    return when (preset) {
        AuntieThemePreset.DEFAULT -> base

        // Dark + vibrant accents. Forces dark; near-black navy base, vivid orange + pink.
        AuntieThemePreset.MIDNIGHT -> base.copy(
            background  = Color(0xFF11131F),
            surface     = Color(0xFF1A1D2B),
            surface2    = Color(0xFF252838),
            surfaceGlass = Color(0x991A1D2B),
            border      = Color(0xFF353748),
            borderSoft  = Color(0xFF2A2C3C),
            primary     = Color(0xFFDF8431),
            primaryDim  = Color(0xFFB36724),
            secondary   = Color(0xFFD55C87),
            accent      = Color(0xFFD55C87),
            textPrimary = BrandCream,
            textDim     = Color(0xCCFBFBF9),
            textFaint   = Color(0x8CFBFBF9),
            isDark      = true,
        )

        // High-contrast accessibility: pure white surfaces, darkened accents for AA on white.
        AuntieThemePreset.CLEAR -> base.copy(
            background  = if (effectiveDark) base.background else Color(0xFFFFFFFF),
            surface     = if (effectiveDark) base.surface else Color(0xFFFFFFFF),
            surface2    = if (effectiveDark) base.surface2 else Color(0xFFF1EFEA),
            surfaceGlass = if (effectiveDark) base.surfaceGlass else Color(0xF2FFFFFF),
            primary     = if (effectiveDark) base.primary else Color(0xFFC26A1E),
            primaryDim  = if (effectiveDark) base.primaryDim else Color(0xFF9A511A),
            accent      = if (effectiveDark) base.accent else Color(0xFF0A6F7C),
            secondary   = if (effectiveDark) base.secondary else Color(0xFFB23B6A),
            textDim     = if (effectiveDark) base.textDim else Color(0xFF3A3940),
        )

        // Gradient combinations: leans on the warm tribe gradient (orange -> pink).
        AuntieThemePreset.SUNSET -> base.copy(
            background  = if (effectiveDark) base.background else Color(0xFFFBEFE6),
            surface     = if (effectiveDark) base.surface else Color(0xFFFCF3EC),
            surface2    = if (effectiveDark) base.surface2 else Color(0xFFF3E3D6),
            primary     = if (effectiveDark) base.primary else KinfolkOrange,
            secondary   = if (effectiveDark) base.secondary else PackPink,
            accent      = if (effectiveDark) base.accent else PackPink,
        )

        // Duotone: navy + orange only; minimize the third/fourth hues.
        AuntieThemePreset.DUO -> base.copy(
            primary     = if (effectiveDark) base.primary else KinfolkOrange,
            secondary   = if (effectiveDark) base.secondary else KinfolkOrange,
            accent      = if (effectiveDark) base.accent else KinfolkOrange,
            tertiary    = base.textPrimary,
            coral       = if (effectiveDark) base.coral else KinfolkOrange,
        )

        // Minimalist: heavy neutral, a single muted teal accent.
        AuntieThemePreset.CALM -> base.copy(
            background  = if (effectiveDark) base.background else Color(0xFFF3F1EC),
            surface     = if (effectiveDark) base.surface else Color(0xFFEDEAE3),
            primary     = if (effectiveDark) base.primary else KinTeal,
            secondary   = if (effectiveDark) base.secondary else KinTeal,
            accent      = if (effectiveDark) base.accent else KinTeal,
            tertiary    = if (effectiveDark) base.tertiary else FamilyPurple,
            coral       = if (effectiveDark) base.coral else KinTeal,
        )

        // Warm neutral / nature: beige + warm orange, earthy teal accent.
        AuntieThemePreset.HEARTH -> base.copy(
            background  = if (effectiveDark) base.background else Color(0xFFF0E7D8),
            surface     = if (effectiveDark) base.surface else Color(0xFFEDE3D2),
            surface2    = if (effectiveDark) base.surface2 else Color(0xFFE2D6C0),
            primary     = if (effectiveDark) base.primary else KinfolkOrange,
            accent      = if (effectiveDark) base.accent else KinTeal,
            coral       = if (effectiveDark) base.coral else Color(0xFFD5535A),
        )

        // Jewel tones: rich purple + sapphire teal, slightly warm surface.
        AuntieThemePreset.JEWEL -> base.copy(
            background  = if (effectiveDark) base.background else Color(0xFFECE7DF),
            surface     = if (effectiveDark) base.surface else Color(0xFFE5DED3),
            primary     = if (effectiveDark) base.primary else FamilyPurple,
            secondary   = if (effectiveDark) base.secondary else KinTeal,
            accent      = if (effectiveDark) base.accent else KinTeal,
            coral       = if (effectiveDark) base.coral else PackPink,
        )

        // Soft-tech pastels: washed pink + lavender, gentle contrast.
        AuntieThemePreset.SOFT -> base.copy(
            background  = if (effectiveDark) base.background else Color(0xFFFBF3F6),
            surface     = if (effectiveDark) base.surface else Color(0xFFF6EBF0),
            surface2    = if (effectiveDark) base.surface2 else Color(0xFFEEDDE6),
            primary     = if (effectiveDark) base.primary else PackPink,
            secondary   = if (effectiveDark) base.secondary else FamilyPurple,
            accent      = if (effectiveDark) base.accent else FamilyPurple,
            success     = if (effectiveDark) base.success else KinTeal,
        )
    }
}
