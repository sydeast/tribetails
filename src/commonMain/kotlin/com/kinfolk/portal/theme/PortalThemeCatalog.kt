package com.kinfolk.portal.theme

import androidx.compose.ui.graphics.Color

/**
 * Maps an operator-chosen `themeId` (from `mytribePortal.themeId`, surfaced via
 * getMyHome → [com.kinfolk.portal.portal.PortalConfig]) to a concrete
 * [KinfolkColors] token set plus an `isDark` flag.
 *
 * The 9 themes are brand-derived per the portal-settings plan (Task 4.1): every
 * theme keeps a dominant hue plus one sharp accent, and `isDark` flips the
 * Material color scheme (not just the tokens) so dark themes read correctly.
 * Each theme is `KinfolkColors()` with the listed overrides only — unlisted
 * tokens keep their canonical brand defaults. An unknown id falls back to
 * `default`, so a never-configured install is byte-identical to today.
 */
fun portalColors(themeId: String): Pair<KinfolkColors, Boolean> = when (themeId) {
    "default" -> KinfolkColors() to false

    // Dark + vibrant: near-black canvas, cream text, orange + pink accents.
    "midnight" -> KinfolkColors(
        cream = Color(0xFF11131F),
        navy = Color(0xFFFBFBF9),
        surface = Color(0xFF1A1D2B),
        surfaceCard = Color.White.copy(alpha = 0.06f),
        navySoft = Color.White.copy(alpha = 0.80f),
        navyMuted = Color.White.copy(alpha = 0.55f),
        navyHairline = Color.White.copy(alpha = 0.12f),
        glassSurface = Color.White.copy(alpha = 0.06f),
        glassSurfaceDim = Color.White.copy(alpha = 0.04f),
        glassBorder = Color.White.copy(alpha = 0.14f),
        primary = Color(0xFFDF8431),
        accent = Color(0xFFD55C87),
    ) to true

    // High-contrast: white canvas, darkened primary/accent for AA on white.
    "clear" -> KinfolkColors(
        cream = Color(0xFFFFFFFF),
        surface = Color(0xFFFFFFFF),
        surfaceCard = Color.White.copy(alpha = 0.85f),
        navySoft = KinfolkBrand.Navy.copy(alpha = 0.92f),
        navyMuted = KinfolkBrand.Navy.copy(alpha = 0.74f),
        primary = Color(0xFFC26A1E),
        accent = Color(0xFFB23B6A),
    ) to false

    // Gradient: warm tinted canvas, leans on the existing tribe gradient.
    "sunset" -> KinfolkColors(
        surface = Color(0xFFFBEFE6),
        surfaceCard = Color.White.copy(alpha = 0.70f),
        primary = Color(0xFFDF8431),
        accent = Color(0xFFD55C87),
    ) to false

    // Duotone: navy + orange only; collapse the extra hues to those two.
    "duo" -> KinfolkColors(
        accent = Color(0xFFDF8431),
        teal = Color(0xFF11131F),
        purple = Color(0xFF11131F),
        coral = Color(0xFFDF8431),
    ) to false

    // Minimalist: one teal accent, heavy neutral.
    "calm" -> KinfolkColors(
        primary = Color(0xFF0A8595),
        accent = Color(0xFF0A8595),
        coral = Color(0xFF0A8595),
        purple = Color(0xFF74538A),
        surface = Color(0xFFF3F1EC),
    ) to false

    // Warm / nature: earthy warm canvas + orange + teal.
    "hearth" -> KinfolkColors(
        surface = Color(0xFFF0E7D8),
        primary = Color(0xFFDF8431),
        accent = Color(0xFF0A8595),
        coral = Color(0xFFD5535A),
    ) to false

    // Jewel tones: purple + sapphire teal, rich.
    "jewel" -> KinfolkColors(
        primary = Color(0xFF74538A),
        accent = Color(0xFF0A8595),
        coral = Color(0xFFD55C87),
        surface = Color(0xFFECE7DF),
    ) to false

    // Soft pastels: washed pink + lavender, gentle.
    "soft" -> KinfolkColors(
        primary = Color(0xFFD55C87),
        accent = Color(0xFF74538A),
        surface = Color(0xFFFBF3F6),
        navySoft = KinfolkBrand.Navy.copy(alpha = 0.72f),
        success = Color(0xFF0A8595),
    ) to false

    else -> KinfolkColors() to false
}
