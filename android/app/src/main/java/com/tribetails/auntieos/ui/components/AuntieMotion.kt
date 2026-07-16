package com.tribetails.auntieos.ui.components

import androidx.compose.animation.*
import androidx.compose.animation.core.*
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.composables.icons.lucide.ChevronDown
import com.composables.icons.lucide.Lucide
import com.tribetails.auntieos.ui.theme.AuntieTheme
import kotlinx.coroutines.delay

// ─── CollapsingSection ────────────────────────────────────────────────────────
// Animated expand/collapse with spring-driven chevron + content size animation.
@Composable
fun CollapsingSection(
    header: String,
    modifier: Modifier = Modifier,
    initiallyExpanded: Boolean = false,
    headerColor: Color = AuntieTheme.colors.textPrimary,
    accentColor: Color = AuntieTheme.colors.primary,
    content: @Composable ColumnScope.() -> Unit,
) {
    var expanded by rememberSaveable { mutableStateOf(initiallyExpanded) }
    val chevronRotation by animateFloatAsState(
        targetValue   = if (expanded) 180f else 0f,
        animationSpec = spring(stiffness = Spring.StiffnessMediumLow, dampingRatio = Spring.DampingRatioLowBouncy),
        label         = "chevron",
    )

    Column(modifier = modifier) {
        val shape = if (expanded) RoundedCornerShape(topStart = 12.dp, topEnd = 12.dp, bottomStart = 0.dp, bottomEnd = 0.dp)
                    else RoundedCornerShape(12.dp)
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clip(shape)
                .background(AuntieTheme.colors.surface)
                .clickable { expanded = !expanded }
                .padding(horizontal = 16.dp, vertical = 14.dp),
            verticalAlignment     = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text(
                text       = header,
                style      = AuntieTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
                color      = headerColor,
            )
            Icon(
                imageVector        = Lucide.ChevronDown,
                contentDescription = if (expanded) "Collapse" else "Expand",
                tint               = accentColor,
                modifier           = Modifier
                    .size(18.dp)
                    .graphicsLayer { rotationZ = chevronRotation },
            )
        }
        AnimatedVisibility(
            visible = expanded,
            enter   = expandVertically(spring(stiffness = Spring.StiffnessMediumLow)) + fadeIn(tween(200)),
            exit    = shrinkVertically(spring(stiffness = Spring.StiffnessMediumLow)) + fadeOut(tween(150)),
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(topStart = 0.dp, topEnd = 0.dp, bottomStart = 12.dp, bottomEnd = 12.dp))
                    .background(AuntieTheme.colors.surface2)
                    .padding(horizontal = 16.dp, vertical = 12.dp),
                content = content,
            )
        }
    }
}

// ─── PulsingBadge ─────────────────────────────────────────────────────────────
// Breathing badge for notification counts / active status indicators.
@Composable
fun PulsingBadge(
    modifier: Modifier = Modifier,
    color: Color = AuntieTheme.colors.primary,
    count: Int? = null,
    pulsing: Boolean = true,
    size: Dp = 10.dp,
) {
    val infiniteTransition = rememberInfiniteTransition(label = "badgePulse")
    val ringScale by if (pulsing) infiniteTransition.animateFloat(
        initialValue  = 1f,
        targetValue   = 1.6f,
        animationSpec = infiniteRepeatable(tween(900, easing = FastOutSlowInEasing), RepeatMode.Reverse),
        label         = "ringScale",
    ) else remember { mutableStateOf(1f) }
    val ringAlpha by if (pulsing) infiniteTransition.animateFloat(
        initialValue  = 0.4f,
        targetValue   = 0f,
        animationSpec = infiniteRepeatable(tween(900, easing = FastOutSlowInEasing), RepeatMode.Reverse),
        label         = "ringAlpha",
    ) else remember { mutableStateOf(0f) }

    Box(modifier = modifier, contentAlignment = Alignment.Center) {
        if (pulsing) {
            Box(
                modifier = Modifier
                    .size(size)
                    .scale(ringScale)
                    .clip(CircleShape)
                    .background(color.copy(alpha = ringAlpha)),
            )
        }
        Box(
            modifier = Modifier
                .size(if (count != null && count > 0) maxOf(size, 16.dp) else size)
                .clip(CircleShape)
                .background(color),
            contentAlignment = Alignment.Center,
        ) {
            if (count != null && count > 0) {
                Text(
                    text       = if (count > 99) "99+" else count.toString(),
                    color      = AuntieTheme.colors.background,
                    style      = AuntieTheme.typography.labelSmall.copy(fontSize = 9.sp),
                    fontWeight = FontWeight.Bold,
                )
            }
        }
    }
}

// ─── StaggerRevealList ────────────────────────────────────────────────────────
// Wraps a list of items; each animates in with a staggered delay.
// Use for LazyColumn items that appear on screen load.
@Composable
fun <T> StaggerRevealList(
    items: List<T>,
    modifier: Modifier = Modifier,
    staggerMs: Int = 60,
    verticalArrangement: Arrangement.Vertical = Arrangement.spacedBy(8.dp),
    itemContent: @Composable ColumnScope.(index: Int, item: T) -> Unit,
) {
    Column(modifier = modifier, verticalArrangement = verticalArrangement) {
        items.forEachIndexed { index, item ->
            val visible = remember { mutableStateOf(false) }
            LaunchedEffect(item) {
                delay(index.toLong() * staggerMs)
                visible.value = true
            }
            AnimatedVisibility(
                visible = visible.value,
                enter   = slideInVertically(
                    initialOffsetY = { it / 3 },
                    animationSpec  = spring(stiffness = Spring.StiffnessMediumLow, dampingRatio = Spring.DampingRatioMediumBouncy),
                ) + fadeIn(tween(200)),
            ) {
                Column { itemContent(index, item) }
            }
        }
    }
}

// ─── Dashboard motion (17.3 alive-widgets pass, mirror of web AuntieMotion) ──

/**
 * Pure display math for a count-up animation: the value shown at [progress]
 * (0..1) of the roll from 0 to [target]. Extracted so tests can pin the curve
 * endpoints without driving a Compose clock. Pure; unit-tested.
 */
fun countUpDisplay(target: Double, progress: Float): Double =
    target * progress.coerceIn(0f, 1f)

/**
 * Rolls a numeric stat up from 0 to [target] once per distinct target, then
 * sits still. [format] turns the in-flight value into the rendered string
 * (count, money, ...). Loading states should render their placeholder INSTEAD
 * of this composable so the roll only ever plays over real data.
 */
@Composable
fun CountUpText(
    target: Double,
    format: (Double) -> String,
    style: androidx.compose.ui.text.TextStyle,
    color: Color,
) {
    val progress = remember(target) { Animatable(0f) }
    LaunchedEffect(target) {
        progress.snapTo(0f)
        progress.animateTo(1f, animationSpec = tween(durationMillis = 700, easing = FastOutSlowInEasing))
    }
    Text(format(countUpDisplay(target, progress.value)), style = style, color = color)
}

/**
 * One dashboard widget's entrance: rise from below + fade, staggered by the
 * widget's [index] in the layout. Plays once per index (re-plays when the
 * operator reorders, which reads as the card taking its new seat).
 */
@Composable
fun DashRevealItem(
    index: Int,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    var visible by remember(index) { mutableStateOf(false) }
    LaunchedEffect(index) {
        delay(index * 70L)
        visible = true
    }
    AnimatedVisibility(
        visible = visible,
        modifier = modifier,
        enter = slideInVertically(spring(dampingRatio = Spring.DampingRatioMediumBouncy)) { it / 3 } + fadeIn(),
    ) {
        content()
    }
}

/**
 * A slow breathe (scale loop) for decorative accents, the watermark-level
 * "never completely static" touch. Gentle by design: 6 percent over 4s.
 */
@Composable
fun Modifier.breathe(enabled: Boolean = true): Modifier {
    if (!enabled) return this
    val transition = rememberInfiniteTransition(label = "breathe")
    val s by transition.animateFloat(
        initialValue = 1f,
        targetValue = 1.06f,
        animationSpec = infiniteRepeatable(tween(4000, easing = FastOutSlowInEasing), RepeatMode.Reverse),
        label = "breatheScale",
    )
    return this.scale(s)
}

// ─── SlideInCard ──────────────────────────────────────────────────────────────
// Card that slides in from the trailing edge on composition. Useful for detail panels.
@Composable
fun SlideInCard(
    modifier: Modifier = Modifier,
    visible: Boolean = true,
    content: @Composable ColumnScope.() -> Unit,
) {
    AnimatedVisibility(
        visible = visible,
        enter   = slideInHorizontally(
            initialOffsetX = { it / 2 },
            animationSpec  = spring(stiffness = Spring.StiffnessMediumLow, dampingRatio = Spring.DampingRatioMediumBouncy),
        ) + fadeIn(tween(250)),
        exit    = slideOutHorizontally(
            targetOffsetX = { it / 2 },
            animationSpec = spring(stiffness = Spring.StiffnessMediumLow),
        ) + fadeOut(tween(200)),
    ) {
        Column(
            modifier = modifier
                .clip(RoundedCornerShape(16.dp))
                .background(AuntieTheme.colors.surface),
            content = content,
        )
    }
}
