package com.tribetails.auntieos.web.ui.shaders

import androidx.compose.foundation.background
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.geometry.Offset
import com.tribetails.auntieos.web.theme.AuntieColors
import kotlinx.browser.window
import org.w3c.dom.events.MouseEvent

actual class PlatformPointerSource actual constructor() {
    private var listener: ((MouseEvent) -> Unit)? = null

    actual fun start(state: PointerState) {
        val l: (MouseEvent) -> Unit = { ev ->
            val w = window.innerWidth.coerceAtLeast(1)
            val h = window.innerHeight.coerceAtLeast(1)
            state.update(ev.clientX.toFloat() / w, ev.clientY.toFloat() / h)
        }
        listener = l
        window.addEventListener("mousemove", l.castToEventHandler())
    }

    actual fun stop() {
        listener?.let { window.removeEventListener("mousemove", it.castToEventHandler()) }
        listener = null
    }
}

@Suppress("UNCHECKED_CAST")
private fun ((MouseEvent) -> Unit).castToEventHandler(): (org.w3c.dom.events.Event) -> Unit =
    this as (org.w3c.dom.events.Event) -> Unit

/**
 * Wasm fallback paints a radial gradient that responds to pointer.
 * (Skia RuntimeEffect plumbing on wasmJs is still maturing in CMP 1.7.x -
 *  swap this for the SkSL pipeline once the shared shader API stabilizes.)
 */
actual fun Modifier.meshGradientBackground(
    colors: AuntieColors,
    pointer: PointerState,
): Modifier {
    val center = Offset(pointer.x, pointer.y)
    return this.background(
        Brush.radialGradient(
            colors = listOf(
                colors.primary.copy(alpha = 0.18f),
                colors.primaryDim.copy(alpha = 0.10f),
                colors.background,
            ),
            center = Offset(center.x * 1000f, center.y * 1000f),
            radius = 1400f,
        ),
    )
}
