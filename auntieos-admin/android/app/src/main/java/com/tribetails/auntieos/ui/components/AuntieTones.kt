package com.tribetails.auntieos.ui.components

import androidx.compose.ui.graphics.Color
import com.tribetails.auntieos.ui.theme.AuntieColors

/**
 * Shared tone enums for the Den component kit (ported from the web app's
 * ui/components/AuntieTones.kt so both surfaces resolve to the SAME brand
 * colors). Resolvers take [AuntieColors] (from AuntieTheme.colors).
 */

enum class AuntieChipTone { Neutral, Accent, Teal, Purple, Orange }

fun AuntieChipTone.accent(c: AuntieColors): Color = when (this) {
    AuntieChipTone.Neutral -> c.textDim
    AuntieChipTone.Accent  -> c.primary
    AuntieChipTone.Teal    -> c.accent
    AuntieChipTone.Purple  -> c.tertiary
    AuntieChipTone.Orange  -> c.primary
}

enum class AuntieStatusTone { Neutral, Success, Warning, Error, Teal, Purple, Orange, Muted }

fun AuntieStatusTone.color(c: AuntieColors): Color = when (this) {
    AuntieStatusTone.Neutral -> c.textDim
    AuntieStatusTone.Success -> c.success
    AuntieStatusTone.Warning -> c.warning
    AuntieStatusTone.Error   -> c.error
    AuntieStatusTone.Teal    -> c.accent
    AuntieStatusTone.Purple  -> c.tertiary
    AuntieStatusTone.Orange  -> c.primary
    AuntieStatusTone.Muted   -> c.textFaint
}

enum class AuntieBannerTone { Info, Success, Warning, Error, Suggestion }

fun AuntieBannerTone.color(c: AuntieColors): Color = when (this) {
    AuntieBannerTone.Info       -> c.accent
    AuntieBannerTone.Success    -> c.success
    AuntieBannerTone.Warning    -> c.warning
    AuntieBannerTone.Error      -> c.error
    AuntieBannerTone.Suggestion -> c.tertiary
}

/** Lightweight spec for avatar clusters (AuntieAvatar / AuntieAvatarStack). */
data class AvatarSpec(
    val imageUrl: String? = null,
    val initials: String? = null,
)
