package com.tribetails.auntieos.ui.calls

import android.Manifest
import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.appcompat.app.AppCompatActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.lifecycleScope
import com.tribetails.auntieos.AuntieOSApp
import com.tribetails.auntieos.MainActivity
import com.tribetails.auntieos.fcm.AuntieFirebaseMessagingService
import com.tribetails.auntieos.ui.components.AuntieSpinner
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import com.tribetails.auntieos.ui.theme.AuntieTheme
import com.tribetails.auntieos.util.AuntieLog
import kotlinx.coroutines.launch

/**
 * What the phone shows on the lock screen when a call is ringing: who is calling,
 * what the attendant heard them say, and the two answers to that.
 *
 * This used to be a WebView pointed at a Twilio Serverless page, with the call sid,
 * the caller number and the free-form TRANSCRIPT pasted RAW into the query string.
 * A caller who said anything containing "&" or "#" split or truncated the URL, so
 * the screen showed the wrong transcript or none at all, and the whole service is
 * being retired anyway. Everything on this screen already arrives in the intent, so
 * there was never a reason to make a network round trip to render it.
 */
class CallScreenActivity : AppCompatActivity() {

    private val viewModel: CallsViewModel by viewModels {
        object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T =
                CallsViewModel(applicationContext, AuntieOSApp.instance.repository) as T
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        turnScreenOnAndKeyguardOff()

        val args = CallScreenArgs.fromExtras { key -> intent.getStringExtra(key) }
        AuntieLog.d("CallScreenActivity showing ${args.callerNumber}")

        // A voicemail hand-off that the server refused must not close the screen: the
        // operator would walk away believing the caller was parked. Close only on the
        // success the ViewModel actually observed.
        lifecycleScope.launch {
            viewModel.voicemailResults.collect { result ->
                if (result.isSuccess) finish()
            }
        }

        setContent {
            AuntieOSTheme {
                val state by viewModel.uiState.collectAsState()

                val micPermission = rememberLauncherForActivityResult(
                    ActivityResultContracts.RequestPermission()
                ) { granted ->
                    if (granted) answerAndOpenCallScreen(args)
                }

                CallScreeningContent(
                    args = args,
                    isActing = state.isActing,
                    actionResult = state.actionResult,
                    onAccept = {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                            micPermission.launch(Manifest.permission.RECORD_AUDIO)
                        } else {
                            answerAndOpenCallScreen(args)
                        }
                    },
                    onSendToVoicemail = { viewModel.sendToVoicemail(args.callSid) }
                )
            }
        }
    }

    /**
     * Answers here, then hands the live call to the main app. Mute, hang up and audio
     * routing all live on the calls screen, so staying on this lock-screen activity
     * would strand the operator in a call with no controls.
     */
    private fun answerAndOpenCallScreen(args: CallScreenArgs) {
        viewModel.answerCall(this)
        startActivity(
            Intent(this, MainActivity::class.java).apply {
                action = AuntieFirebaseMessagingService.ACTION_OPEN_CALL
                putExtra(AuntieFirebaseMessagingService.EXTRA_CALL_SID, args.callSid)
                putExtra(AuntieFirebaseMessagingService.EXTRA_CALLER_NUMBER, args.callerNumber)
                putExtra(AuntieFirebaseMessagingService.EXTRA_TRANSCRIPT, args.transcript)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            }
        )
        finish()
    }

    private fun turnScreenOnAndKeyguardOff() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
            val keyguardManager = getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
            keyguardManager.requestDismissKeyguard(this, null)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON or
                        WindowManager.LayoutParams.FLAG_ALLOW_LOCK_WHILE_SCREEN_ON or
                        WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                        WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
            )
        }
    }
}

/**
 * The three things the screen renders, read from the intent the FCM service built.
 *
 * Pulled out of the activity so the read is testable without a device, and keyed off
 * [AuntieFirebaseMessagingService]'s own constants rather than a second copy of the
 * literals "CALL_SID" / "CALLER_NUMBER" / "TRANSCRIPT". Values are carried through
 * verbatim: a transcript is whatever the caller said, punctuation included.
 */
data class CallScreenArgs(
    val callSid: String,
    val callerNumber: String,
    val transcript: String,
) {
    companion object {
        fun fromExtras(getExtra: (String) -> String?): CallScreenArgs = CallScreenArgs(
            callSid = getExtra(AuntieFirebaseMessagingService.EXTRA_CALL_SID).orEmpty(),
            callerNumber = getExtra(AuntieFirebaseMessagingService.EXTRA_CALLER_NUMBER).orEmpty(),
            transcript = getExtra(AuntieFirebaseMessagingService.EXTRA_TRANSCRIPT).orEmpty(),
        )
    }
}

@Composable
internal fun CallScreeningContent(
    args: CallScreenArgs,
    isActing: Boolean,
    actionResult: String?,
    onAccept: () -> Unit,
    onSendToVoicemail: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(AuntieTheme.colors.background)
            .padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("INCOMING CALL", color = AuntieTheme.colors.kinfolkOrange, style = AuntieTheme.typography.labelSmall)

        Text(
            args.callerNumber.ifBlank { "Unknown caller" },
            style = AuntieTheme.typography.headlineMedium,
            fontWeight = FontWeight.Bold,
        )

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f)
                .clip(RoundedCornerShape(8.dp))
                .background(AuntieTheme.colors.surface)
                .padding(16.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text("WHAT THEY SAID", style = AuntieTheme.typography.labelSmall, color = AuntieTheme.colors.textDim)
            Text(
                args.transcript.ifBlank { "The caller did not say why they are calling." },
                style = AuntieTheme.typography.bodyMedium,
            )
        }

        actionResult?.let { message ->
            Text(message, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textDim)
        }

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            ScreeningButton(
                label = "Accept",
                background = AuntieTheme.colors.success,
                enabled = !isActing,
                showSpinner = false,
                onClick = onAccept,
                modifier = Modifier.weight(1f),
            )
            ScreeningButton(
                label = "Voicemail",
                background = AuntieTheme.colors.error,
                enabled = !isActing,
                showSpinner = isActing,
                onClick = onSendToVoicemail,
                modifier = Modifier.weight(1f),
            )
        }

        Spacer(Modifier.height(4.dp))
    }
}

@Composable
private fun ScreeningButton(
    label: String,
    background: Color,
    enabled: Boolean,
    showSpinner: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Box(
        modifier = modifier
            .height(52.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(if (enabled) background else background.copy(alpha = 0.5f))
            .clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        if (showSpinner) {
            AuntieSpinner(modifier = Modifier.size(18.dp), color = Color.White, strokeWidth = 2.dp)
        } else {
            Text(label, color = Color.White, fontWeight = FontWeight.Bold, style = AuntieTheme.typography.labelLarge)
        }
    }
}
