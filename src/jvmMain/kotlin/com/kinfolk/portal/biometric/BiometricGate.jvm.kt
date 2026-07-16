package com.kinfolk.portal.biometric

class JvmBiometricGate : BiometricGate {
    override suspend fun requireRecentAuth(scopeKey: String, maxAgeSeconds: Int): BiometricResult =
        BiometricResult.Unsupported
}

actual fun createBiometricGate(): BiometricGate = JvmBiometricGate()
