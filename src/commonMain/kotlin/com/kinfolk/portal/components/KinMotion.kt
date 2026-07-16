package com.kinfolk.portal.components

import androidx.compose.animation.*
import androidx.compose.animation.core.*
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.kinfolk.portal.theme.KinfolkTheme
import kotlinx.coroutines.delay

// CollapsingSection — warm cream collapsible with spring chevron
// Note: Lucide icons not present in dependencies; using Text "▾" toggle instead.
@Composable
fun KinCollapsingSection(
    header: @Composable () -> Unit,
    modifier: Modifier = Modifier,
    initiallyExpanded: Boolean = false,
    content: @Composable ColumnScope.() -> Unit,
) {
    val c = KinfolkTheme.colors
    var expanded by rememberSaveable { mutableStateOf(initiallyExpanded) }
    val chevronRotation by animateFloatAsState(
        targetValue   = if (expanded) 180f else 0f,
        animationSpec = spring(dampingRatio = Spring.DampingRatioLowBouncy, stiffness = Spring.StiffnessMedium),
        label         = "chevron",
    )
    val shape = if (expanded) RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp) else RoundedCornerShape(16.dp)

    Column(modifier = modifier) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clip(shape)
                .background(c.glassSurface)
                .clickable { expanded = !expanded }
                .padding(horizontal = 16.dp, vertical = 14.dp),
            verticalAlignment     = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Box(modifier = Modifier.weight(1f)) { header() }
            Text(
                text     = "▾",
                color    = c.primary,
                fontSize = 18.sp,
                modifier = Modifier.rotate(chevronRotation),
            )
        }
        AnimatedVisibility(
            visible = expanded,
            enter   = expandVertically(spring(dampingRatio = Spring.DampingRatioMediumBouncy)) + fadeIn(),
            exit    = shrinkVertically(tween(200)) + fadeOut(tween(200)),
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(bottomStart = 16.dp, bottomEnd = 16.dp))
                    .background(c.surface),
                content = content,
            )
        }
    }
}

// StaggerRevealList — heritage fade-up reveals with warm spring
@Composable
fun <T> KinStaggerReveal(
    items: List<T>,
    modifier: Modifier = Modifier,
    staggerMs: Long = 60L,
    verticalArrangement: Arrangement.Vertical = Arrangement.spacedBy(0.dp),
    itemContent: @Composable ColumnScope.(item: T) -> Unit,
) {
    Column(modifier = modifier, verticalArrangement = verticalArrangement) {
        items.forEachIndexed { index, item ->
            var visible by remember(item) { mutableStateOf(false) }
            LaunchedEffect(item) {
                delay(index * staggerMs)
                visible = true
            }
            AnimatedVisibility(
                visible = visible,
                enter   = slideInVertically(spring(dampingRatio = Spring.DampingRatioMediumBouncy)) { it / 3 } + fadeIn(),
            ) {
                itemContent(item)
            }
        }
    }
}

// SlideInCard — horizontal spring reveal
@Composable
fun KinSlideInCard(
    modifier: Modifier = Modifier,
    visible: Boolean = true,
    content: @Composable () -> Unit,
) {
    AnimatedVisibility(
        visible  = visible,
        modifier = modifier,
        enter    = slideInHorizontally(spring(dampingRatio = Spring.DampingRatioMediumBouncy)) { it / 3 } + fadeIn(),
        exit     = slideOutHorizontally(tween(200)) { it / 3 } + fadeOut(tween(200)),
    ) {
        content()
    }
}
