package com.tribetails.auntieos.web.theme

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * Warm-start cache encode/decode. The whole point of the FOUC fix is that what we
 * write on a theme change is exactly what we read back on the next boot, and that a
 * blank/garbage cache degrades to "no warm-start" (defaults) rather than crashing.
 */
class ThemeCacheTest {

    @Test
    fun roundTrip_preservesModeAndAllThreeKnobs() {
        val mode = ThemeMode.LIGHT
        val p = ThemePersonalization(
            accent = AccentChoice.OCEAN,
            density = DensityChoice.ROOMY,
            fontScale = FontScaleChoice.LARGE,
        )
        assertEquals(CachedTheme(mode, p), decodeThemeCache(encodeThemeCache(mode, p)))
    }

    @Test
    fun roundTrip_defaults() {
        val mode = ThemeMode.DARK
        val p = ThemePersonalization()
        assertEquals(CachedTheme(mode, p), decodeThemeCache(encodeThemeCache(mode, p)))
    }

    @Test
    fun decode_nullBlankOrTooFewParts_isNull() {
        assertNull(decodeThemeCache(null))
        assertNull(decodeThemeCache(""))
        assertNull(decodeThemeCache("DARK"))
        assertNull(decodeThemeCache("DARK|ORANGE|NORMAL")) // only 3 parts
    }

    @Test
    fun decode_unknownMode_isNull() {
        // We can't fail-safe a mode token we don't recognize, so the whole cache is
        // treated as absent and the caller uses its default.
        assertNull(decodeThemeCache("BOGUS|ORANGE|NORMAL|MEDIUM"))
    }

    @Test
    fun decode_unknownKnobTokens_failSafeToEnumDefaults() {
        assertEquals(
            CachedTheme(
                ThemeMode.DARK,
                ThemePersonalization(
                    AccentChoice.DEFAULT,
                    DensityChoice.DEFAULT,
                    FontScaleChoice.DEFAULT,
                ),
            ),
            decodeThemeCache("DARK|BOGUS|BOGUS|BOGUS"),
        )
    }
}
