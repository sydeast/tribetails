package com.kinfolk.portal.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.kinfolk.portal.generated.resources.Res
import com.kinfolk.portal.generated.resources.bricolage_grotesque
import com.kinfolk.portal.generated.resources.dm_mono_medium
import com.kinfolk.portal.generated.resources.dm_mono_regular
import com.kinfolk.portal.generated.resources.young_serif_regular
import org.jetbrains.compose.resources.Font

/**
 * Locked Tribe Tails brand palette.
 * Source: TribeTails_Docs/Communication/AuntieOS/android/Scratch Folder/brandColors.md
 */
object KinfolkBrand {
    val Cream = Color(0xFFFBFBF9)
    val Navy = Color(0xFF11131F)
    val KinfolkOrange = Color(0xFFDF8431)
    val PackPink = Color(0xFFD55C87)
    val KinTeal = Color(0xFF0A8595)
    val FamilyPurple = Color(0xFF74538A)
    val SnuggleCoral = Color(0xFFD5535A)

    val NavySoft = Navy.copy(alpha = 0.78f)
    val NavyMuted = Navy.copy(alpha = 0.55f)
    val NavyHairline = Navy.copy(alpha = 0.10f)

    /** Translucent surface for "glass" cards — works across all platforms. */
    val GlassSurface = Color.White.copy(alpha = 0.62f)
    val GlassSurfaceDim = Color.White.copy(alpha = 0.38f)
    val GlassBorder = Color.White.copy(alpha = 0.55f)

    /** Aliases retained for legacy references during the migration. */
    @Deprecated("Use KinfolkOrange", ReplaceWith("KinfolkBrand.KinfolkOrange"))
    val Orange get() = KinfolkOrange
    @Deprecated("Use PackPink", ReplaceWith("KinfolkBrand.PackPink"))
    val Magenta get() = PackPink
    @Deprecated("Use KinTeal", ReplaceWith("KinfolkBrand.KinTeal"))
    val Teal get() = KinTeal
}

object KinfolkGradients {
    /** Tribe Gradient — orange → pink → teal. Hero / CTAs only. */
    val tribe = Brush.linearGradient(
        colors = listOf(KinfolkBrand.KinfolkOrange, KinfolkBrand.PackPink, KinfolkBrand.KinTeal),
        start = Offset.Zero,
        end = Offset(800f, 800f),
    )

    /** Header wash — soft top-down gradient on Cream. Used behind app bar. */
    val headerWash = Brush.verticalGradient(
        colors = listOf(
            KinfolkBrand.KinfolkOrange.copy(alpha = 0.18f),
            KinfolkBrand.PackPink.copy(alpha = 0.10f),
            KinfolkBrand.Cream.copy(alpha = 0f),
        ),
    )

    /** Orange to Pink — service cards, accents. */
    val orangeToPink = Brush.linearGradient(
        colors = listOf(KinfolkBrand.KinfolkOrange, KinfolkBrand.PackPink),
        start = Offset.Zero,
        end = Offset(400f, 400f),
    )

    /** Dimmed orange→pink for in-flight / disabled CTA states. */
    val orangeToPinkDim = Brush.linearGradient(
        colors = listOf(
            KinfolkBrand.KinfolkOrange.copy(alpha = 0.55f),
            KinfolkBrand.PackPink.copy(alpha = 0.55f),
        ),
        start = Offset.Zero,
        end = Offset(400f, 400f),
    )

    /** Teal to Purple — calm sections, testimonial-style cards. */
    val tealToPurple = Brush.linearGradient(
        colors = listOf(KinfolkBrand.KinTeal, KinfolkBrand.FamilyPurple),
        start = Offset.Zero,
        end = Offset(400f, 400f),
    )
}

object KinfolkShapes {
    val card: Shape = RoundedCornerShape(20.dp)
    val cardSmall: Shape = RoundedCornerShape(14.dp)
    val pill: Shape = RoundedCornerShape(999.dp)
    val sheet: Shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp, bottomStart = 0.dp, bottomEnd = 0.dp)
}

object KinfolkSpacing {
    val xs: Dp = 4.dp
    val s: Dp = 8.dp
    val m: Dp = 16.dp
    val l: Dp = 24.dp
    val xl: Dp = 32.dp
    val xxl: Dp = 48.dp
    val gutter: Dp = 20.dp
}

data class KinfolkTypography(
    val heritageDisplay: TextStyle,
    val heritageTitle: TextStyle,
    val heritageSection: TextStyle,
    val sansLabel: TextStyle,
    val sansBody: TextStyle,
    val sansMeta: TextStyle,
    val sansButton: TextStyle,
)

val LocalKinfolkTypography = staticCompositionLocalOf {
    KinfolkTypography(
        heritageDisplay = TextStyle.Default,
        heritageTitle = TextStyle.Default,
        heritageSection = TextStyle.Default,
        sansLabel = TextStyle.Default,
        sansBody = TextStyle.Default,
        sansMeta = TextStyle.Default,
        sansButton = TextStyle.Default,
    )
}

// Headless colors token object — avoids MaterialTheme dependency in components
data class KinfolkColors(
    val cream: Color = KinfolkBrand.Cream,
    val navy: Color = KinfolkBrand.Navy,
    val navySoft: Color = KinfolkBrand.NavySoft,
    val navyMuted: Color = KinfolkBrand.NavyMuted,
    val navyHairline: Color = KinfolkBrand.NavyHairline,
    val primary: Color = KinfolkBrand.KinfolkOrange,
    val accent: Color = KinfolkBrand.PackPink,
    val teal: Color = KinfolkBrand.KinTeal,
    val purple: Color = KinfolkBrand.FamilyPurple,
    val coral: Color = KinfolkBrand.SnuggleCoral,
    val glassSurface: Color = KinfolkBrand.GlassSurface,
    val glassSurfaceDim: Color = KinfolkBrand.GlassSurfaceDim,
    val glassBorder: Color = KinfolkBrand.GlassBorder,
    val surface: Color = Color(0xFFEFEAE0),
    val surfaceCard: Color = Color.White.copy(alpha = 0.62f),
    val success: Color = KinfolkBrand.KinTeal,
    val error: Color = KinfolkBrand.SnuggleCoral,
)

val LocalKinfolkColors = staticCompositionLocalOf { KinfolkColors() }

object KinfolkTheme {
    val colors: KinfolkColors @Composable @ReadOnlyComposable get() = LocalKinfolkColors.current
    val typography: KinfolkTypography @Composable @ReadOnlyComposable get() = LocalKinfolkTypography.current
}

@Composable
fun KinfolkPortalTheme(themeId: String = "default", content: @Composable () -> Unit) {
    // Resolve the operator-chosen theme to a token set + dark flag. Unknown id →
    // default (canonical), so a never-configured install is unchanged.
    val (colors, isDark) = portalColors(themeId)
    // Brand fonts, bundled in commonMain/composeResources/font. Young Serif is the
    // heritage serif (headings); Bricolage Grotesque is the functional sans (body,
    // labels, buttons); DM Mono carries the monospaced "meta" texture (kickers,
    // small caps labels) the mockups use. Bricolage ships as a variable font, so
    // heavier weights come from Compose font synthesis rather than separate files.
    val heritageSerif = FontFamily(Font(Res.font.young_serif_regular))
    val functionalSans = FontFamily(Font(Res.font.bricolage_grotesque))
    val functionalMono = FontFamily(
        Font(Res.font.dm_mono_regular, FontWeight.Normal),
        Font(Res.font.dm_mono_medium, FontWeight.Medium),
    )
    val typography = KinfolkTypography(
        heritageDisplay = TextStyle(
            fontFamily = heritageSerif,
            fontWeight = FontWeight.Bold,
            fontSize = 32.sp,
            color = KinfolkBrand.Navy,
            letterSpacing = (-0.5).sp,
        ),
        heritageTitle = TextStyle(
            fontFamily = heritageSerif,
            fontWeight = FontWeight.SemiBold,
            fontSize = 22.sp,
            color = KinfolkBrand.Navy,
            letterSpacing = (-0.2).sp,
        ),
        heritageSection = TextStyle(
            fontFamily = heritageSerif,
            fontWeight = FontWeight.SemiBold,
            fontSize = 18.sp,
            color = KinfolkBrand.Navy,
        ),
        sansLabel = TextStyle(
            fontFamily = functionalSans,
            fontWeight = FontWeight.Medium,
            fontSize = 13.sp,
            color = KinfolkBrand.NavySoft,
            letterSpacing = 0.2.sp,
        ),
        sansBody = TextStyle(
            fontFamily = functionalSans,
            fontWeight = FontWeight.Normal,
            fontSize = 15.sp,
            color = KinfolkBrand.Navy,
            lineHeight = 22.sp,
        ),
        sansMeta = TextStyle(
            fontFamily = functionalMono,
            fontWeight = FontWeight.Medium,
            fontSize = 12.sp,
            color = KinfolkBrand.NavyMuted,
            letterSpacing = 0.4.sp,
        ),
        sansButton = TextStyle(
            fontFamily = functionalSans,
            fontWeight = FontWeight.SemiBold,
            fontSize = 15.sp,
            color = Color.White,
            letterSpacing = 0.3.sp,
        ),
    )

    // Material scheme is built from the resolved [colors] tokens (not the raw
    // brand constants) so a theme's overrides flow into M3 surfaces too. Dark
    // themes (e.g. midnight) flip the whole scheme to darkColorScheme — a token
    // swap alone wouldn't fix M3's own light defaults. `colors.cream` is the
    // canvas/background and `colors.navy` the on-canvas text in every theme
    // (midnight inverts both), so they map to background/surface + on* here.
    val scheme = if (isDark) {
        darkColorScheme(
            primary = colors.primary,
            onPrimary = Color.White,
            secondary = colors.accent,
            onSecondary = Color.White,
            tertiary = colors.teal,
            onTertiary = Color.White,
            background = colors.cream,
            onBackground = colors.navy,
            surface = colors.surface,
            onSurface = colors.navy,
            surfaceVariant = colors.surface,
            onSurfaceVariant = colors.navySoft,
            error = colors.error,
            onError = Color.White,
            outline = colors.navyHairline,
        )
    } else {
        lightColorScheme(
            primary = colors.primary,
            onPrimary = Color.White,
            secondary = colors.accent,
            onSecondary = Color.White,
            tertiary = colors.teal,
            onTertiary = Color.White,
            background = colors.cream,
            onBackground = colors.navy,
            surface = colors.surface,
            onSurface = colors.navy,
            surfaceVariant = colors.surface,
            onSurfaceVariant = colors.navySoft,
            error = colors.error,
            onError = Color.White,
            outline = colors.navyHairline,
        )
    }

    CompositionLocalProvider(
        LocalKinfolkTypography provides typography,
        LocalKinfolkColors provides colors,
    ) {
        MaterialTheme(
            colorScheme = scheme,
            content = content,
        )
    }
}
