package com.tribetails.auntieos.ui.theme

// ─────────────────────────────────────────────────────────────────────────────
// DESIGN SYSTEM RULE: Never use M3 visual components in screens.
// Use AuntieCard, AuntieField, AuntieTopBar, AuntieFab, AuntieChip,
// AuntieIconBtn, AuntieModal, AuntieSpinner, AuntieTabRow, PrimaryButton,
// GhostButton, BottomBorderField from ui/components/.
// M3 is only kept here so Text/Icon/DropdownMenu/DatePicker still function.
// ─────────────────────────────────────────────────────────────────────────────

import android.app.Activity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat

private val LocalAuntieColors     = staticCompositionLocalOf<AuntieColors>     { error("AuntieColors not provided") }
private val LocalAuntieTypography = staticCompositionLocalOf { DefaultAuntieTypography }
private val LocalAuntieShapes     = staticCompositionLocalOf { DefaultAuntieShapes }
private val LocalAuntieDimensions = staticCompositionLocalOf { DefaultAuntieDimensions }

enum class ThemeMode { SYSTEM, LIGHT, DARK }

val LocalThemeMode = staticCompositionLocalOf { ThemeMode.SYSTEM }

object AuntieTheme {
    val colors:     AuntieColors     @Composable @ReadOnlyComposable get() = LocalAuntieColors.current
    val typography: AuntieTypography @Composable @ReadOnlyComposable get() = LocalAuntieTypography.current
    val shapes:     AuntieShapes     @Composable @ReadOnlyComposable get() = LocalAuntieShapes.current
    val dims:       AuntieDimensions @Composable @ReadOnlyComposable get() = LocalAuntieDimensions.current
}

private fun AuntieTypography.toM3() = Typography(
    displayLarge   = displayLarge,
    displayMedium  = displayMedium,
    headlineLarge  = headlineLarge,
    headlineMedium = headlineMedium,
    headlineSmall  = headlineSmall,
    titleLarge     = titleLarge,
    titleMedium    = titleMedium,
    titleSmall     = titleSmall,
    bodyLarge      = bodyLarge,
    bodyMedium     = bodyMedium,
    bodySmall      = bodySmall,
    labelLarge     = labelLarge,
    labelMedium    = labelMedium,
    labelSmall     = labelSmall,
)

@Composable
fun AuntieOSTheme(
    themeMode: ThemeMode = ThemeMode.SYSTEM,
    personalization: ThemePersonalization = ThemePersonalization(),
    content:   @Composable () -> Unit,
) {
    val systemDark = isSystemInDarkTheme()
    val darkTheme = when (themeMode) {
        ThemeMode.LIGHT  -> false
        ThemeMode.DARK   -> true
        ThemeMode.SYSTEM -> systemDark
    }
    // 17.1: base palette by mode, then overlay the operator's accent / density / scale.
    val auntieColors = (if (darkTheme) DarkAuntieColors else LightAuntieColors)
        .withAccent(personalization.accent)
    val auntieDimensions = DefaultAuntieDimensions.scaled(personalization.density)
    val auntieTypography = DefaultAuntieTypography.scaled(personalization.fontScale)

    val m3 = if (darkTheme) {
        darkColorScheme(
            primary          = auntieColors.primary,
            onPrimary        = auntieColors.background,
            primaryContainer = auntieColors.primaryDim,
            secondary        = auntieColors.secondary,
            onSecondary      = auntieColors.textPrimary,
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
            onError          = Color.White,
        )
    } else {
        lightColorScheme(
            primary          = auntieColors.primary,
            onPrimary        = auntieColors.background,
            primaryContainer = auntieColors.primaryDim,
            secondary        = auntieColors.secondary,
            onSecondary      = auntieColors.textPrimary,
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
            onError          = Color.White,
        )
    }

    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as? Activity)?.window ?: return@SideEffect
            WindowCompat.getInsetsController(window, view).isAppearanceLightStatusBars = !darkTheme
        }
    }

    CompositionLocalProvider(
        LocalAuntieColors     provides auntieColors,
        LocalAuntieTypography provides auntieTypography,
        LocalAuntieShapes     provides DefaultAuntieShapes,
        LocalAuntieDimensions provides auntieDimensions,
        LocalThemeMode        provides themeMode,
    ) {
        MaterialTheme(
            colorScheme = m3,
            typography  = auntieTypography.toM3(),
            content     = content,
        )
    }
}

