package com.tribetails.auntieos.web.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.web.theme.AuntieTheme

/**
 * AuntieMediaGrid - adaptive square-thumbnail grid for the Den component kit.
 *
 * Renders [items] into a [LazyVerticalGrid] sized with [GridCells.Adaptive] so columns
 * reflow to fill the available width. Each cell is forced to a 1:1 square and wrapped in
 * the Den glass treatment (clipped rounded corners, soft surface, hairline border) so the
 * caller's [cell] slot only needs to paint content (image, video poster, file tile, etc.).
 *
 * Generic over the item type [T]. Supply a stable [key] so recompositions and scroll
 * position survive list reordering.
 *
 * Visuals are built from foundation primitives only (Box + LazyVerticalGrid). No Material3
 * containers. Colors, spacing, and corner radius resolve from [AuntieTheme].
 */
@Composable
fun <T> AuntieMediaGrid(
    items: List<T>,
    key: (T) -> Any,
    modifier: Modifier = Modifier,
    minCellSize: Dp = 120.dp,
    gap: Dp = 12.dp,
    cell: @Composable (T) -> Unit,
) {
    val c = AuntieTheme.colors
    val cornerRadius = 12.dp

    LazyVerticalGrid(
        columns = GridCells.Adaptive(minSize = minCellSize),
        modifier = modifier.fillMaxWidth(),
        contentPadding = PaddingValues(gap),
        horizontalArrangement = Arrangement.spacedBy(gap),
        verticalArrangement = Arrangement.spacedBy(gap),
    ) {
        items(items, key = { key(it) }) { item ->
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .aspectRatio(1f)
                    .clip(RoundedCornerShape(cornerRadius))
                    .background(c.surface2)
                    .border(AuntieTheme.dims.borderHairline, c.border, RoundedCornerShape(cornerRadius)),
            ) {
                Box(modifier = Modifier.fillMaxSize()) {
                    cell(item)
                }
            }
        }
    }
}
