package com.tribetails.auntieos.web.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf

enum class ThemeMode { SYSTEM, LIGHT, DARK }

val LocalThemeMode = staticCompositionLocalOf { ThemeMode.SYSTEM }

private val LocalAuntieColors      = staticCompositionLocalOf<AuntieColors>      { error("AuntieColors not provided") }
private val LocalAuntieTypography  = staticCompositionLocalOf { DefaultAuntieTypography }
private val LocalAuntieShapes      = staticCompositionLocalOf { DefaultAuntieShapes }
private val LocalAuntieDimensions  = staticCompositionLocalOf { DefaultAuntieDimensions }

object AuntieTheme {
    val colors:     AuntieColors      @Composable @ReadOnlyComposable get() = LocalAuntieColors.current
    val typography: AuntieTypography  @Composable @ReadOnlyComposable get() = LocalAuntieTypography.current
    val shapes:     AuntieShapes      @Composable @ReadOnlyComposable get() = LocalAuntieShapes.current
    val dims:       AuntieDimensions  @Composable @ReadOnlyComposable get() = LocalAuntieDimensions.current
}

@Composable
fun AuntieAppTheme(
    themeMode: ThemeMode = ThemeMode.DARK,
    personalization: ThemePersonalization = ThemePersonalization(),
    content:  @Composable () -> Unit,
) {
    val systemDark = isSystemInDarkTheme()
    val modeDark = when (themeMode) {
        ThemeMode.LIGHT  -> false
        ThemeMode.DARK   -> true
        ThemeMode.SYSTEM -> systemDark
    }
    // An intrinsically-dark preset (e.g. midnight) forces the dark scheme so the
    // whole Material/Auntie palette flips, not just the token swaps.
    val darkMode = modeDark || personalization.themePreset.forcesDark
    // Named preset sets the base color set (default = today's base), then overlay
    // the operator's accent choice on top.
    val auntieColors = auntiePresetColors(personalization.themePreset, darkMode)
        .withAccent(personalization.accent)
    val auntieDimensions = DefaultAuntieDimensions.scaled(personalization.density)

    // Provide a Material3 ColorScheme bridge so any M3 component used
    // (e.g. via Composables UI's underlying primitives) reads brand colors.
    val m3 = if (darkMode) {
        darkColorScheme(
            primary          = auntieColors.primary,
            onPrimary        = auntieColors.background,
            primaryContainer = auntieColors.primaryDim,
            secondary        = auntieColors.secondary,
            tertiary         = auntieColors.tertiary,
            background       = auntieColors.background,
            onBackground     = auntieColors.textPrimary,
            surface          = auntieColors.surface,
            onSurface        = auntieColors.textPrimary,
            surfaceVariant   = auntieColors.surface2,
            onSurfaceVariant = auntieColors.textDim,
            outline          = auntieColors.border,
            error            = auntieColors.error,
            errorContainer   = auntieColors.errorContainer,
        )
    } else {
        lightColorScheme(
            primary          = auntieColors.primary,
            onPrimary        = auntieColors.background,
            primaryContainer = auntieColors.primaryDim,
            secondary        = auntieColors.secondary,
            tertiary         = auntieColors.tertiary,
            background       = auntieColors.background,
            onBackground     = auntieColors.textPrimary,
            surface          = auntieColors.surface,
            onSurface        = auntieColors.textPrimary,
            surfaceVariant   = auntieColors.surface2,
            onSurfaceVariant = auntieColors.textDim,
            outline          = auntieColors.border,
            error            = auntieColors.error,
            errorContainer   = auntieColors.errorContainer,
        )
    }

    CompositionLocalProvider(
        LocalAuntieColors     provides auntieColors,
        LocalAuntieTypography provides rememberDenTypography().scaled(personalization.fontScale),
        LocalAuntieShapes     provides DefaultAuntieShapes,
        LocalAuntieDimensions provides auntieDimensions,
        LocalThemeMode        provides themeMode,
    ) {
        MaterialTheme(colorScheme = m3, typography = rememberDenMaterialTypography(), content = content)
    }
}
