package com.tribetails.auntieos.web.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.unit.dp

@Immutable
data class AuntieShapes(
    val pill:   Shape = RoundedCornerShape(999.dp),
    val card:   Shape = RoundedCornerShape(8.dp),
    val cardLg: Shape = RoundedCornerShape(12.dp),
    val chip:   Shape = RoundedCornerShape(6.dp),
    val tight:  Shape = RoundedCornerShape(4.dp),
)

val DefaultAuntieShapes = AuntieShapes()
