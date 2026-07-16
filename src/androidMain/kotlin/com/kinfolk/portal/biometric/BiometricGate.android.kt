package com.kinfolk.portal.biometric

import android.content.Context
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.fragment.app.FragmentActivity
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

private var hostActivity: FragmentActivity? = null
private var hostContext: Context? = null

fun setBiometricHost(activity: FragmentActivity) { hostActivity = activity; hostContext = activity }

class AndroidBiometricGate : BiometricGate {
    private val recent = mutableMapOf<String, Long>()

    override suspend fun requireRecentAuth(scopeKey: String, maxAgeSeconds: Int): BiometricResult {
        val now = System.currentTimeMillis() / 1000
        recent[scopeKey]?.let { if (now - it < maxAgeSeconds) return BiometricResult.Granted }
        val ctx = hostContext ?: return BiometricResult.Unsupported
        val activity = hostActivity ?: return BiometricResult.Unsupported
        val manager = BiometricManager.from(ctx)
        if (manager.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG)
            != BiometricManager.BIOMETRIC_SUCCESS
        ) return BiometricResult.Unsupported
        return suspendCancellableCoroutine { cont ->
            val executor = ctx.mainExecutor
            val prompt = BiometricPrompt(
                activity, executor,
                object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                        recent[scopeKey] = System.currentTimeMillis() / 1000
                        cont.resume(BiometricResult.Granted)
                    }
                    override fun onAuthenticationFailed() {
                        cont.resume(BiometricResult.Failed)
                    }
                    override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                        cont.resume(if (errorCode == BiometricPrompt.ERROR_LOCKOUT) BiometricResult.LockedOut else BiometricResult.Failed)
                    }
                },
            )
            val info = BiometricPrompt.PromptInfo.Builder()
                .setTitle("Confirm it's you")
                .setSubtitle("Required to view secure data")
                .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
                .setNegativeButtonText("Cancel")
                .build()
            prompt.authenticate(info)
        }
    }
}

actual fun createBiometricGate(): BiometricGate = AndroidBiometricGate()
