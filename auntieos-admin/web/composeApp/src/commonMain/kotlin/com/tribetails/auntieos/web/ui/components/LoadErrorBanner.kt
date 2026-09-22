package com.tribetails.auntieos.web.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.web.theme.AuntieTheme
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.onEach

const val LOAD_ERROR_RETRY_TAG = "load-error-retry"

/**
 * #867: what a screen shows in place of its loading shimmer when the read it is
 * waiting on failed (signed out, refused, or timed out). Without it the shimmer
 * never ends and the operator cannot tell a slow network from a broken one.
 *
 * #867 review: with [onRetry] it carries a Retry button that reads again now
 * instead of at the next poll, and shows a spinner while [retrying].
 */
@Composable
fun LoadErrorBanner(
    title: String,
    message: String,
    modifier: Modifier = Modifier,
    onRetry: (() -> Unit)? = null,
    retrying: Boolean = false,
) {
    AuntieBanner(
        modifier = modifier,
        tone = AuntieBannerTone.Error,
        title = title,
        trailing = onRetry?.let { retry ->
            {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(AuntieTheme.dims.space2)) {
                    GhostButton(
                        label = if (retrying) "Retrying" else "Retry",
                        onClick = retry,
                        enabled = !retrying,
                        modifier = Modifier.testTag(LOAD_ERROR_RETRY_TAG),
                        leading = if (retrying) {
                            { AuntieSpinner(modifier = Modifier.size(14.dp)) }
                        } else null,
                    )
                    AuntieInfoTip("This also tries again by itself every few seconds.")
                }
            }
        },
    ) {
        Text(message, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.error)
    }
}

/**
 * #867 review: a read a screen can start again. Key the stream's `remember` on
 * [generation] and pass the stream through [settlesRetry]: [retry] builds a fresh
 * stream (the old one's collection is cancelled), and [retrying] stays true until
 * that stream answers, which is what the banner's spinner shows.
 */
@Stable
class ReloadableRead {
    var generation by mutableIntStateOf(0)
        private set
    var retrying by mutableStateOf(false)
        internal set

    fun retry() {
        retrying = true
        generation++
    }
}

@Composable
fun rememberReloadableRead(): ReloadableRead = remember { ReloadableRead() }

/** Clears [ReloadableRead.retrying] when this stream emits. */
fun <T> Flow<T>.settlesRetry(read: ReloadableRead): Flow<T> = onEach { read.retrying = false }
