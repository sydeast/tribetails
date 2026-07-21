package com.tribetails.auntieos.web.theme

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

/**
 * The named staff-UI theme catalog: parse fail-safe, the default-is-base back-compat
 * guarantee, the intrinsic-dark force, and that every preset actually changes the
 * look (so a picked theme is never a silent no-op). This is the pure logic the
 * Appearance preset cards + AuntieAppTheme are thin over.
 */
class AuntieThemeCatalogTest {

    @Test
    fun parse_canonical_caseInsensitive_andFailSafe() {
        assertEquals(AuntieThemePreset.MIDNIGHT, AuntieThemePreset.parse("midnight"))
        assertEquals(AuntieThemePreset.JEWEL, AuntieThemePreset.parse(" JEWEL "))
        assertEquals(AuntieThemePreset.DEFAULT, AuntieThemePreset.parse(""))
        assertEquals(AuntieThemePreset.DEFAULT, AuntieThemePreset.parse(null))
        assertEquals(AuntieThemePreset.DEFAULT, AuntieThemePreset.parse("rainbow"))
    }

    @Test
    fun default_isExactlyTheBase_bothModes() {
        // Back-compat: a never-customized install reads byte-identical to today.
        assertEquals(LightAuntieColors, auntiePresetColors(AuntieThemePreset.DEFAULT, isDark = false))
        assertEquals(DarkAuntieColors, auntiePresetColors(AuntieThemePreset.DEFAULT, isDark = true))
    }

    @Test
    fun midnight_forcesDark_evenInLightMode() {
        assertTrue(AuntieThemePreset.MIDNIGHT.forcesDark)
        val resolved = auntiePresetColors(AuntieThemePreset.MIDNIGHT, isDark = false)
        assertTrue(resolved.isDark)
    }

    @Test
    fun everyNonDefaultPreset_changesTheLook_inLight() {
        // A picked theme must visibly differ from the base, or the card is a no-op.
        AuntieThemePreset.entries
            .filter { it != AuntieThemePreset.DEFAULT }
            .forEach { preset ->
                val resolved = auntiePresetColors(preset, isDark = false)
                assertNotEquals(LightAuntieColors, resolved, "Preset ${preset.key} should differ from the base")
            }
    }

    @Test
    fun swatch_exposesDominantAndAccent() {
        // The picker card reads the preset's own resolved background + primary.
        val sw = AuntieThemePreset.SOFT.swatch(isDark = false)
        val resolved = auntiePresetColors(AuntieThemePreset.SOFT, isDark = false)
        assertEquals(resolved.background, sw.dominant)
        assertEquals(resolved.primary, sw.accent)
    }
}
