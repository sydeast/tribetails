package com.tribetails.auntieos.web.ui.shaders

import androidx.compose.ui.Modifier
import com.tribetails.auntieos.web.theme.AuntieColors

actual class PlatformPointerSource actual constructor() {
    actual fun start(state: PointerState) = Unit
    actual fun stop() = Unit
}

actual fun Modifier.meshGradientBackground(
    colors: AuntieColors,
    pointer: PointerState,
): Modifier = this
