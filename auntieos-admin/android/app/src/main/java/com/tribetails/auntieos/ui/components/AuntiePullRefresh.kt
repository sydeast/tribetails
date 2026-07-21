package com.tribetails.auntieos.ui.components

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.Velocity
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.ui.theme.AuntieTheme

// ─────────────────────────────────────────────────────────────────────────────
// AuntiePullRefresh - replaces M3 PullToRefreshBox
// Foundation-only (NestedScrollConnection) pull-to-refresh with Auntie* spinner.
// ─────────────────────────────────────────────────────────────────────────────

private const val PULL_RESISTANCE = 0.5f

internal fun computePullProgress(offsetPx: Float, thresholdPx: Float): Float {
    if (thresholdPx <= 0f) return 0f
    if (offsetPx <= 0f) return 0f
    return (offsetPx / thresholdPx).coerceAtMost(1f)
}

internal fun shouldTriggerRefresh(offsetPx: Float, thresholdPx: Float, isRefreshing: Boolean): Boolean =
    !isRefreshing && offsetPx >= thresholdPx

internal fun applyPullResistance(rawDeltaY: Float): Float =
    if (rawDeltaY <= 0f) 0f else rawDeltaY * PULL_RESISTANCE

@Composable
fun AuntiePullRefresh(
    isRefreshing: Boolean,
    onRefresh: () -> Unit,
    modifier: Modifier = Modifier,
    triggerThreshold: Dp = 64.dp,
    content: @Composable BoxScope.() -> Unit,
) {
    val density = LocalDensity.current
    val thresholdPx = with(density) { triggerThreshold.toPx() }
    var pullOffset by remember { mutableFloatStateOf(0f) }

    val nestedScroll = remember(isRefreshing, thresholdPx) {
        object : NestedScrollConnection {
            override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
                // Consume upward scroll first to retract the indicator.
                if (available.y < 0 && pullOffset > 0f) {
                    val consume = (-pullOffset).coerceAtLeast(available.y)
                    pullOffset = (pullOffset + consume).coerceAtLeast(0f)
                    return Offset(0f, consume)
                }
                return Offset.Zero
            }

            override fun onPostScroll(
                consumed: Offset,
                available: Offset,
                source: NestedScrollSource,
            ): Offset {
                if (!isRefreshing && available.y > 0f && source == NestedScrollSource.UserInput) {
                    pullOffset += applyPullResistance(available.y)
                    return Offset(0f, available.y)
                }
                return Offset.Zero
            }

            override suspend fun onPreFling(available: Velocity): Velocity {
                if (shouldTriggerRefresh(pullOffset, thresholdPx, isRefreshing)) {
                    onRefresh()
                }
                pullOffset = 0f
                return Velocity.Zero
            }
        }
    }

    LaunchedEffect(isRefreshing) {
        if (!isRefreshing) pullOffset = 0f
    }

    val indicatorOffsetPx by animateFloatAsState(
        targetValue = if (isRefreshing) thresholdPx else pullOffset,
        label       = "pullIndicatorOffset",
    )
    val progress = computePullProgress(indicatorOffsetPx, thresholdPx)

    Box(modifier = modifier.nestedScroll(nestedScroll)) {
        content()
        Box(
            modifier = Modifier
                .align(Alignment.TopCenter)
                .offset(y = with(density) { (indicatorOffsetPx - thresholdPx).toDp() })
                .padding(top = 16.dp)
                .alpha(progress.coerceAtLeast(if (isRefreshing) 1f else 0f)),
        ) {
            AuntieSpinner(
                modifier = Modifier
                    .size(28.dp)
                    .rotate(if (isRefreshing) 0f else progress * 270f),
                color = AuntieTheme.colors.kinfolkOrange,
            )
        }
    }
    // Silence unused warning - rememberCoroutineScope reserved for future fling kick.
    rememberCoroutineScope()
}
