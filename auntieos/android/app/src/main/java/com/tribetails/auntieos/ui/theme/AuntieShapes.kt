package com.tribetails.auntieos.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.unit.dp

@Immutable
data class AuntieShapes(
    val pill:    Shape = RoundedCornerShape(999.dp),
    val card:    Shape = RoundedCornerShape(16.dp),
    val cardLg:  Shape = RoundedCornerShape(22.dp),
    val cardXl:  Shape = RoundedCornerShape(28.dp),
    val chip:    Shape = RoundedCornerShape(10.dp),
    val tight:   Shape = RoundedCornerShape(8.dp),
)

val DefaultAuntieShapes = AuntieShapes()
