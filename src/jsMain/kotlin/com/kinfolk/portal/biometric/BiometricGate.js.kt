package com.kinfolk.portal.biometric

import kotlinx.browser.window

class JsBiometricGate : BiometricGate {
    private val recent = mutableMapOf<String, Long>()
    override suspend fun requireRecentAuth(scopeKey: String, maxAgeSeconds: Int): BiometricResult {
        val supported = js("typeof window !== 'undefined' && !!window.PublicKeyCredential") as Boolean
        if (!supported) return BiometricResult.Unsupported
        return BiometricResult.Unsupported
    }
}

actual fun createBiometricGate(): BiometricGate = JsBiometricGate()
