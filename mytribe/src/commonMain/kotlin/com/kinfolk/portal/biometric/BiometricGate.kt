package com.kinfolk.portal.biometric

enum class BiometricResult { Granted, Failed, Unsupported, LockedOut }

interface BiometricGate {
    suspend fun requireRecentAuth(scopeKey: String, maxAgeSeconds: Int = 300): BiometricResult
}

expect fun createBiometricGate(): BiometricGate
