package com.tribetails.auntieos.web.ui.components

import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.theme.AuntieTheme
import kotlinx.coroutines.flow.Flow

const val STALE_READ_TAG = "stale-read-banner"
const val NOT_FOUND_TAG = "not-found-notice"

/**
 * #898: what a screen knows about one polled read. A read that fails after it
 * has already answered once keeps the last good [data] and sets [error], so a
 * dropped poll can mark the screen's data out of date instead of blanking a
 * list or a form the operator has unsaved edits in.
 *
 * [hasLoaded] is tracked separately from `data != null`, because a read may
 * legitimately answer with a real null or an empty list.
 */
data class ReadSnapshot<T>(
    val data: T? = null,
    val hasLoaded: Boolean = false,
    val error: String? = null,
) {
    /** Answered at least once; the latest attempt failed. Data on screen is old. */
    val stale: Boolean get() = hasLoaded && error != null

    /** Never answered; the latest (only) attempt failed. */
    val failed: Boolean get() = !hasLoaded && error != null

    /** Never answered, and nothing has failed yet. */
    val loading: Boolean get() = !hasLoaded && error == null

    fun absorb(result: FirestoreResult<T>): ReadSnapshot<T> = when (result) {
        FirestoreResult.Loading -> this
        is FirestoreResult.Data -> ReadSnapshot(result.value, hasLoaded = true, error = null)
        is FirestoreResult.Error -> copy(error = result.message)
    }
}

/**
 * #898: a polled read a screen can show, mark stale, and start again. Built on
 * the #867 [ReloadableRead]: [retry] bumps its generation, which restarts the
 * stream's collection while the last good [ReadSnapshot.data] stays on screen.
 */
@Stable
class LiveRead<T> {
    var snapshot by mutableStateOf(ReadSnapshot<T>())
        internal set
    val reload = ReloadableRead()

    val data: T? get() = snapshot.data
    val hasLoaded: Boolean get() = snapshot.hasLoaded
    val error: String? get() = snapshot.error
    val retrying: Boolean get() = reload.retrying

    fun retry() = reload.retry()
}

/** #898: collects [stream] into a [LiveRead]. [keys] name the read; a new key value starts a fresh one. */
@Composable
fun <T> rememberLiveRead(vararg keys: Any?, stream: () -> Flow<FirestoreResult<T>>): LiveRead<T> {
    val read = remember(*keys) { LiveRead<T>() }
    val currentStream = rememberUpdatedState(stream)
    LaunchedEffect(read, read.reload.generation, *keys) {
        currentStream.value().settlesRetry(read.reload).collect { r ->
            read.snapshot = read.snapshot.absorb(r)
        }
    }
    return read
}

/**
 * #898: the one banner a polled read needs. Before any answer, a failure shows
 * [LoadErrorBanner] with Retry. After an answer, a failure shows [StaleReadBanner]
 * instead: the data on screen stays, marked out of date, also with Retry.
 * Nothing renders while the read is healthy.
 */
@Composable
fun ReadStatusBanner(read: LiveRead<*>, what: String, modifier: Modifier = Modifier) {
    val s = read.snapshot
    when {
        s.failed -> LoadErrorBanner("Couldn't load $what", s.error.orEmpty(), modifier, onRetry = read::retry, retrying = read.retrying)
        s.stale -> StaleReadBanner(what, s.error.orEmpty(), modifier, onRetry = read::retry, retrying = read.retrying)
    }
}

/** #898: the last refresh of [what] failed; what is on screen is the last good copy. */
@Composable
fun StaleReadBanner(what: String, message: String, modifier: Modifier = Modifier, onRetry: () -> Unit, retrying: Boolean) {
    AuntieBanner(
        modifier = modifier.testTag(STALE_READ_TAG),
        tone = AuntieBannerTone.Warning,
        title = "Couldn't refresh $what",
        trailing = { RetryControl(onRetry, retrying) },
    ) {
        Text(
            "$message Showing what loaded earlier, which may be out of date.",
            style = AuntieTheme.typography.bodySmall,
            color = AuntieTheme.colors.textDim,
        )
    }
}

/** #898: the read answered and this record is not in it (deleted, or a stale link). */
@Composable
fun NotFoundNotice(message: String, onBack: () -> Unit, modifier: Modifier = Modifier) {
    AuntieBanner(
        modifier = modifier.testTag(NOT_FOUND_TAG),
        tone = AuntieBannerTone.Warning,
        title = "Not found",
        trailing = { GhostButton(label = "Go back", onClick = onBack) },
    ) {
        Text(message, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textDim)
    }
}
