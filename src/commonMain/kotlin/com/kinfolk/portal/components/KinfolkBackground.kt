package com.kinfolk.portal.components

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import com.kinfolk.portal.theme.KinfolkBrand
import kotlin.math.max

/**
 * Signature MyTribe backdrop: Brand Cream washed with three soft radial gradients
 * (orange top-right, pink top-left, teal bottom-center), mirroring the mockup's
 * layered body background. Deliberately STATIC, no infinite animation, so it never
 * keeps a Compose UI test from reaching idle. Render it behind a transparent
 * Surface/Scaffold so the whole app sits on the wash.
 */
@Composable
fun KinfolkBackground(modifier: Modifier = Modifier) {
    Box(
        modifier = modifier.fillMaxSize().drawBehind {
            drawRect(KinfolkBrand.Cream)
            val r = max(size.width, size.height)
            fun wash(color: Color, cx: Float, cy: Float, scale: Float) {
                drawRect(
                    brush = Brush.radialGradient(
                        colors = listOf(color, Color.Transparent),
                        center = Offset(size.width * cx, size.height * cy),
                        radius = r * scale,
                    ),
                )
            }
            wash(KinfolkBrand.KinfolkOrange.copy(alpha = 0.20f), 0.82f, -0.10f, 1.15f)
            wash(KinfolkBrand.PackPink.copy(alpha = 0.16f), 0.05f, 0.0f, 1.05f)
            wash(KinfolkBrand.KinTeal.copy(alpha = 0.16f), 0.50f, 1.18f, 1.20f)
        },
    )
}
