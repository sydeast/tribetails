package com.tribetails.auntieos.ui.components

import androidx.compose.animation.core.*
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.composables.icons.lucide.ChevronDown
import com.composables.icons.lucide.Lucide
import com.tribetails.auntieos.ui.theme.AuntieTheme

data class AuntieColumn<T>(
    val header: String,
    val weight: Float = 1f,
    val sortable: Boolean = true,
    val sortKey: ((T) -> Comparable<*>)? = null,
    val cell: @Composable RowScope.(item: T) -> Unit,
)

@Composable
fun <T : Any> AuntieTable(
    columns: List<AuntieColumn<T>>,
    rows: List<T>,
    modifier: Modifier = Modifier,
    showSearch: Boolean = true,
    searchQuery: String = "",
    onSearchChange: (String) -> Unit = {},
    filterPredicate: ((T, String) -> Boolean)? = null,
    emptyText: String = "No results",
    key: ((T) -> Any)? = null,
) {
    val c = AuntieTheme.colors
    var sortColumn by remember { mutableStateOf<Int?>(null) }
    var sortAscending by remember { mutableStateOf(true) }

    val displayRows = remember(rows, searchQuery, sortColumn, sortAscending) {
        val filtered = if (searchQuery.isBlank() || filterPredicate == null) rows
                       else rows.filter { filterPredicate(it, searchQuery) }
        val col = sortColumn
        if (col != null) {
            val sk = columns.getOrNull(col)?.sortKey
            if (sk != null) {
                @Suppress("UNCHECKED_CAST")
                if (sortAscending) filtered.sortedWith(compareBy { sk(it) as Comparable<Any> })
                else               filtered.sortedWith(compareByDescending { sk(it) as Comparable<Any> })
            } else filtered
        } else filtered
    }

    Column(modifier = modifier) {
        if (showSearch) {
            AuntieField(
                value         = searchQuery,
                onValueChange = onSearchChange,
                placeholder   = "Search…",
                modifier      = Modifier.fillMaxWidth().padding(bottom = 8.dp),
            )
        }

        // Header row
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(topStart = 8.dp, topEnd = 8.dp))
                .background(c.surface2)
                .padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            columns.forEachIndexed { idx, col ->
                val isSortedByThis = sortColumn == idx
                val chevronRotation by animateFloatAsState(
                    targetValue   = if (isSortedByThis && !sortAscending) 180f else 0f,
                    animationSpec = spring(stiffness = Spring.StiffnessMedium),
                    label         = "sort$idx",
                )
                Row(
                    modifier = Modifier
                        .weight(col.weight)
                        .then(if (col.sortable && col.sortKey != null) Modifier.clickable {
                            if (sortColumn == idx) sortAscending = !sortAscending
                            else { sortColumn = idx; sortAscending = true }
                        } else Modifier),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Text(
                        text       = col.header.uppercase(),
                        style      = AuntieTheme.typography.labelSmall,
                        fontWeight = FontWeight.SemiBold,
                        color      = if (isSortedByThis) c.kinfolkOrange else c.textDim,
                    )
                    if (col.sortable && col.sortKey != null) {
                        Icon(
                            imageVector        = Lucide.ChevronDown,
                            contentDescription = null,
                            tint               = if (isSortedByThis) c.kinfolkOrange else c.textFaint,
                            modifier           = Modifier.size(12.dp).rotate(chevronRotation),
                        )
                    }
                }
            }
        }

        // Data rows
        if (displayRows.isEmpty()) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(bottomStart = 8.dp, bottomEnd = 8.dp))
                    .background(c.surface)
                    .border(0.5.dp, c.border, RoundedCornerShape(bottomStart = 8.dp, bottomEnd = 8.dp))
                    .padding(24.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(emptyText, style = AuntieTheme.typography.bodySmall, color = c.textFaint)
            }
        } else {
            LazyColumn(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(bottomStart = 8.dp, bottomEnd = 8.dp))
                    .border(0.5.dp, c.border, RoundedCornerShape(bottomStart = 8.dp, bottomEnd = 8.dp)),
            ) {
                itemsIndexed(displayRows, key = if (key != null) { _, item -> key(item) } else null) { idx, item ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(if (idx % 2 == 0) c.surface else c.surface2.copy(alpha = 0.5f))
                            .padding(horizontal = 12.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        columns.forEach { col ->
                            Box(modifier = Modifier.weight(col.weight)) {
                                col.cell(this@Row, item)
                            }
                        }
                    }
                    if (idx < displayRows.size - 1) {
                        Box(modifier = Modifier.fillMaxWidth().height(0.5.dp).background(c.border))
                    }
                }
            }
        }
    }
}
