package com.tribetails.auntieos.ui.theme

import com.tribetails.auntieos.data.model.UserProfile
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 17.1 theme-basics pure logic, Android parity with the web ThemePersonalizationTest:
 * accent / density / font-scale parse (fail-safe), the theme-application math
 * (withAccent / dims.scaled / typography.scaled), and the UserProfile round-trip +
 * rehydration. Keeps both apps reading identical users/{uid} keys.
 */
class ThemePersonalizationTest {

    @Test fun accent_parse_canonical_and_caseInsensitive() {
        assertEquals(AccentChoice.ORANGE, AccentChoice.parse("ORANGE"))
        assertEquals(AccentChoice.PINK, AccentChoice.parse("pink"))
        assertEquals(AccentChoice.CORAL, AccentChoice.parse(" coral "))
    }

    @Test fun accent_parse_failSafe_forBlankNullGarbage() {
        assertEquals(AccentChoice.ORANGE, AccentChoice.parse(""))
        assertEquals(AccentChoice.ORANGE, AccentChoice.parse(null))
        assertEquals(AccentChoice.ORANGE, AccentChoice.parse("rainbow"))
    }

    @Test fun density_and_fontScale_parse_failSafe() {
        assertEquals(DensityChoice.COMPACT, DensityChoice.parse("compact"))
        assertEquals(DensityChoice.NORMAL, DensityChoice.parse(""))
        assertEquals(DensityChoice.NORMAL, DensityChoice.parse("ginormous"))
        assertEquals(FontScaleChoice.LARGE, FontScaleChoice.parse("large"))
        assertEquals(FontScaleChoice.MEDIUM, FontScaleChoice.parse(""))
        assertEquals(FontScaleChoice.MEDIUM, FontScaleChoice.parse("huge"))
    }

    @Test fun withAccent_drivesPrimaryAndAccent_perMode() {
        // #9: the chosen hue now drives BOTH primary and accent so picking a color
        // visibly changes the look.
        val light = LightAuntieColors.withAccent(AccentChoice.PINK)
        assertEquals(AccentChoice.PINK.light, light.accent)
        assertEquals(AccentChoice.PINK.light, light.primary)
        val dark = DarkAuntieColors.withAccent(AccentChoice.PINK)
        assertEquals(AccentChoice.PINK.dark, dark.accent)
        assertEquals(AccentChoice.PINK.dark, dark.primary)
        // The ORANGE default keeps the shipped brand primary unchanged.
        assertEquals(LightAuntieColors.primary, LightAuntieColors.withAccent(AccentChoice.ORANGE).primary)
    }

    @Test fun withAccent_gradientChoice_setsBrush_andDrivesPrimaryFromGradientLead() {
        // #9 fix (Run 4): a gradient accent exposes a brush (for PrimaryButton) AND drives
        // primary/accent from the gradient's lead hue, so every accent surface shifts. Before,
        // gradients left primary on the base hue and the UI looked "stuck on orange".
        val tribeGrad = AccentChoice.TRIBE.gradientColors(LightAuntieColors)!!
        val tribe = LightAuntieColors.withAccent(AccentChoice.TRIBE)
        assertNotNull(tribe.accentBrush)
        assertEquals(tribeGrad.first(), tribe.primary)
        assertEquals(tribeGrad.first(), tribe.accent)
        // OCEAN (teal->purple) must visibly leave the base orange: primary becomes the teal lead.
        val oceanGrad = AccentChoice.OCEAN.gradientColors(LightAuntieColors)!!
        assertEquals(oceanGrad.first(), LightAuntieColors.withAccent(AccentChoice.OCEAN).primary)
        assertNull(LightAuntieColors.withAccent(AccentChoice.PINK).accentBrush)
    }

    @Test fun density_scaled_changesSpacing_andNormalIsIdentity() {
        assertEquals(DefaultAuntieDimensions, DefaultAuntieDimensions.scaled(DensityChoice.NORMAL))
        val compact = DefaultAuntieDimensions.scaled(DensityChoice.COMPACT)
        assertTrue(compact.space4.value < DefaultAuntieDimensions.space4.value)
        val roomy = DefaultAuntieDimensions.scaled(DensityChoice.ROOMY)
        assertTrue(roomy.space4.value > DefaultAuntieDimensions.space4.value)
        // Structural width is intentionally NOT scaled.
        assertEquals(DefaultAuntieDimensions.maxContentWidth, roomy.maxContentWidth)
    }

    @Test fun fontScale_scaled_multipliesSizes_andMediumIsIdentity() {
        assertEquals(DefaultAuntieTypography, DefaultAuntieTypography.scaled(FontScaleChoice.MEDIUM))
        val large = DefaultAuntieTypography.scaled(FontScaleChoice.LARGE)
        val base = DefaultAuntieTypography.bodyMedium.fontSize.value
        assertEquals(base * 1.15f, large.bodyMedium.fontSize.value, 0.01f)
        assertNotEquals(
            DefaultAuntieTypography.displayLarge.fontSize.value,
            large.displayLarge.fontSize.value,
        )
    }

    @Test fun userProfile_roundTrip_eachKnob() {
        val p = UserProfile()
            .withAccent(AccentChoice.PINK)
            .withDensity(DensityChoice.ROOMY)
            .withFontScale(FontScaleChoice.SMALL)
        assertEquals("PINK", p.accentColor)
        assertEquals("ROOMY", p.density)
        assertEquals("SMALL", p.fontScale)
        val hydrated = hydratedPersonalization(p)
        assertEquals(AccentChoice.PINK, hydrated.accent)
        assertEquals(DensityChoice.ROOMY, hydrated.density)
        assertEquals(FontScaleChoice.SMALL, hydrated.fontScale)
    }

    @Test fun hydratedPersonalization_legacyDoc_and_null_allDefaults() {
        for (profile in listOf(UserProfile(), null)) {
            val hydrated = hydratedPersonalization(profile)
            assertEquals(AccentChoice.ORANGE, hydrated.accent)
            assertEquals(DensityChoice.NORMAL, hydrated.density)
            assertEquals(FontScaleChoice.MEDIUM, hydrated.fontScale)
        }
    }
}
