package com.tribetails.auntieos.ui.inbox
import android.media.AudioAttributes
import android.media.MediaPlayer
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.ui.components.GhostButton
import com.tribetails.auntieos.ui.components.PrimaryButton
import com.tribetails.auntieos.ui.theme.AuntieTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import java.io.File
private sealed interface PlayerSource {
    data object Loading : PlayerSource
    data class Ready(val dataSource: String) : PlayerSource
    data class Failed(val message: String) : PlayerSource
}
/**
 * The in-app player for a voicemail or a call recording (#1573).
 *
 * The stored Twilio link needs credentials, so the audio is fetched through
 * `getRecordingAudio`, cached to a private file and played from there. Every
 * wait shows a cue, a failure says why and offers a retry, and the player is
 * released when the sheet closes. The position counts up while playing, so
 * "stuck at 0:00" cannot pass for working.
 */
@Composable
internal fun RecordingPlayerBlock(
    entry: InboxEntry,
    load: suspend (kind: String, id: String) -> Result<RecordingAudio>,
) {
    val context = LocalContext.current
    val c = AuntieTheme.colors
    val kind = recordingKindOf(entry.channel) ?: return
    var attempt by remember(entry.id) { mutableIntStateOf(0) }
    var source by remember(entry.id) { mutableStateOf<PlayerSource>(PlayerSource.Loading) }
    LaunchedEffect(entry.id, attempt) {
        source = PlayerSource.Loading
        source = load(kind, entry.id).fold(
            onSuccess = { audio ->
                when (audio) {
                    is RecordingAudio.Url -> PlayerSource.Ready(audio.url)
                    is RecordingAudio.Bytes -> runCatching {
                        withContext(Dispatchers.IO) {
                            val dir = File(context.cacheDir, "recordings").apply { mkdirs() }
                            val file = File(dir, "${entry.id.filter { it.isLetterOrDigit() }}.${if (audio.contentType.contains("wav")) "wav" else "mp3"}")
                            file.writeBytes(audio.bytes)
                            file.absolutePath
                        }
                    }.fold(
                        onSuccess = { PlayerSource.Ready(it) },
                        onFailure = { PlayerSource.Failed("Could not save the recording to play it: ${it.message ?: "storage error"}") },
                    )
                }
            },
            onFailure = { PlayerSource.Failed(it.message ?: "Could not load the recording.") },
        )
    }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.fillMaxWidth()) {
        when (val s = source) {
            PlayerSource.Loading ->
                Text("Loading the recording…", style = AuntieTheme.typography.bodySmall, color = c.textDim)
            is PlayerSource.Failed -> {
                Text(s.message, style = AuntieTheme.typography.bodySmall, color = c.error)
                GhostButton(label = "Try again", onClick = { attempt++ }, modifier = Modifier.fillMaxWidth())
            }
            is PlayerSource.Ready -> PlayerControls(s.dataSource)
        }
    }
}
@Composable
private fun PlayerControls(dataSource: String) {
    val c = AuntieTheme.colors
    var preparing by remember(dataSource) { mutableStateOf(false) }
    var playing by remember(dataSource) { mutableStateOf(false) }
    var positionMs by remember(dataSource) { mutableIntStateOf(0) }
    var durationMs by remember(dataSource) { mutableIntStateOf(0) }
    var error by remember(dataSource) { mutableStateOf<String?>(null) }
    val player = remember(dataSource) { MediaPlayer() }
    var prepared by remember(dataSource) { mutableStateOf(false) }
    DisposableEffect(dataSource) {
        player.setAudioAttributes(
            AudioAttributes.Builder()
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .build(),
        )
        player.setOnPreparedListener {
            prepared = true
            preparing = false
            durationMs = it.duration
            it.start()
            playing = true
        }
        player.setOnCompletionListener {
            playing = false
            positionMs = 0
            it.seekTo(0)
        }
        player.setOnErrorListener { _, _, _ ->
            error = "The recording could not be played."
            preparing = false
            playing = false
            true
        }
        onDispose { runCatching { player.release() } }
    }
    LaunchedEffect(playing) {
        while (playing) {
            positionMs = runCatching { player.currentPosition }.getOrDefault(0)
            delay(250)
        }
    }
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
        PrimaryButton(
            label = when {
                preparing -> "Loading…"
                playing -> "Pause"
                else -> "Play recording"
            },
            enabled = !preparing,
            onClick = {
                error = null
                when {
                    playing -> { player.pause(); playing = false }
                    prepared -> { player.start(); playing = true }
                    else -> runCatching {
                        preparing = true
                        player.setDataSource(dataSource)
                        player.prepareAsync()
                    }.onFailure {
                        preparing = false
                        error = "The recording could not be played."
                    }
                }
            },
            modifier = Modifier.weight(1f),
        )
    }
    Text(
        "${formatPlayerClock(positionMs)} / ${formatPlayerClock(durationMs)}",
        style = AuntieTheme.typography.bodySmall,
        color = c.textDim,
    )
    error?.let { Text(it, style = AuntieTheme.typography.bodySmall, color = c.error) }
}
