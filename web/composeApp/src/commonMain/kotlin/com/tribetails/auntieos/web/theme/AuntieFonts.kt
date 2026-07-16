package com.tribetails.auntieos.web.theme

import androidx.compose.material3.Typography
import androidx.compose.runtime.Composable
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import com.tribetails.auntieos.web.resources.Res
import com.tribetails.auntieos.web.resources.fraunces_light
import com.tribetails.auntieos.web.resources.fraunces_regular
import com.tribetails.auntieos.web.resources.fraunces_medium
import com.tribetails.auntieos.web.resources.fraunces_semibold
import com.tribetails.auntieos.web.resources.hanken_light
import com.tribetails.auntieos.web.resources.hanken_regular
import com.tribetails.auntieos.web.resources.hanken_medium
import com.tribetails.auntieos.web.resources.hanken_semibold
import com.tribetails.auntieos.web.resources.hanken_bold
import com.tribetails.auntieos.web.resources.spline_mono_regular
import com.tribetails.auntieos.web.resources.spline_mono_medium
import com.tribetails.auntieos.web.resources.spline_mono_semibold
import org.jetbrains.compose.resources.Font

/**
 * Den redesign type families. Bundled as static TTF instances under
 * commonMain/composeResources/font so Skia (Wasm) and Desktop both render the
 * real faces (no browser CSS fonts on the canvas).
 *
 *  - Fraunces        : editorial serif for display / headline / large titles
 *  - Hanken Grotesk  : UI + body text, smaller titles, most labels
 *  - Spline Sans Mono: monospace + the uppercase tracked kicker labels
 */
class DenFamilies(
    val fraunces: FontFamily,
    val hanken:   FontFamily,
    val mono:     FontFamily,
)

@Composable
fun rememberDenFamilies(): DenFamilies = DenFamilies(
    fraunces = FontFamily(
        Font(Res.font.fraunces_light,    FontWeight.Light),
        Font(Res.font.fraunces_regular,  FontWeight.Normal),
        Font(Res.font.fraunces_medium,   FontWeight.Medium),
        Font(Res.font.fraunces_semibold, FontWeight.SemiBold),
    ),
    hanken = FontFamily(
        Font(Res.font.hanken_light,    FontWeight.Light),
        Font(Res.font.hanken_regular,  FontWeight.Normal),
        Font(Res.font.hanken_medium,   FontWeight.Medium),
        Font(Res.font.hanken_semibold, FontWeight.SemiBold),
        Font(Res.font.hanken_bold,     FontWeight.Bold),
    ),
    mono = FontFamily(
        Font(Res.font.spline_mono_regular,  FontWeight.Normal),
        Font(Res.font.spline_mono_medium,   FontWeight.Medium),
        Font(Res.font.spline_mono_semibold, FontWeight.SemiBold),
    ),
)

/**
 * The AuntieTheme typography tier with Den faces mapped on. Every screen that
 * reads `AuntieTheme.typography.*` picks these up. Fraunces reads best at
 * lighter editorial weights than the default sans bolds, so the display /
 * headline tier is eased down to Normal / Medium.
 */
@Composable
fun rememberDenTypography(base: AuntieTypography = DefaultAuntieTypography): AuntieTypography {
    val f = rememberDenFamilies()
    return base.copy(
        displayLarge   = base.displayLarge.copy(fontFamily = f.fraunces, fontWeight = FontWeight.Normal),
        displayMedium  = base.displayMedium.copy(fontFamily = f.fraunces, fontWeight = FontWeight.Normal),
        headlineLarge  = base.headlineLarge.copy(fontFamily = f.fraunces, fontWeight = FontWeight.Normal),
        headlineMedium = base.headlineMedium.copy(fontFamily = f.fraunces, fontWeight = FontWeight.Medium),
        headlineSmall  = base.headlineSmall.copy(fontFamily = f.fraunces, fontWeight = FontWeight.Medium),
        titleLarge     = base.titleLarge.copy(fontFamily = f.fraunces, fontWeight = FontWeight.Medium),
        titleMedium    = base.titleMedium.copy(fontFamily = f.hanken),
        titleSmall     = base.titleSmall.copy(fontFamily = f.hanken),
        bodyLarge      = base.bodyLarge.copy(fontFamily = f.hanken),
        bodyMedium     = base.bodyMedium.copy(fontFamily = f.hanken),
        bodySmall      = base.bodySmall.copy(fontFamily = f.hanken),
        labelLarge     = base.labelLarge.copy(fontFamily = f.hanken),
        labelMedium    = base.labelMedium.copy(fontFamily = f.hanken),
        labelSmall     = base.labelSmall.copy(fontFamily = f.mono),
        mono           = base.mono.copy(fontFamily = f.mono),
    )
}

/**
 * Material3 typography so any bare `Text("x")` (no explicit AuntieTheme style)
 * and any M3 primitive inherit the Den faces instead of M3's default sans.
 * Display / headline / titleLarge use Fraunces; everything else Hanken.
 */
@Composable
fun rememberDenMaterialTypography(): Typography {
    val f = rememberDenFamilies()
    val d = Typography()
    return d.copy(
        displayLarge   = d.displayLarge.copy(fontFamily = f.fraunces),
        displayMedium  = d.displayMedium.copy(fontFamily = f.fraunces),
        displaySmall   = d.displaySmall.copy(fontFamily = f.fraunces),
        headlineLarge  = d.headlineLarge.copy(fontFamily = f.fraunces),
        headlineMedium = d.headlineMedium.copy(fontFamily = f.fraunces),
        headlineSmall  = d.headlineSmall.copy(fontFamily = f.fraunces),
        titleLarge     = d.titleLarge.copy(fontFamily = f.fraunces),
        titleMedium    = d.titleMedium.copy(fontFamily = f.hanken),
        titleSmall     = d.titleSmall.copy(fontFamily = f.hanken),
        bodyLarge      = d.bodyLarge.copy(fontFamily = f.hanken),
        bodyMedium     = d.bodyMedium.copy(fontFamily = f.hanken),
        bodySmall      = d.bodySmall.copy(fontFamily = f.hanken),
        labelLarge     = d.labelLarge.copy(fontFamily = f.hanken),
        labelMedium    = d.labelMedium.copy(fontFamily = f.hanken),
        labelSmall     = d.labelSmall.copy(fontFamily = f.hanken),
    )
}
