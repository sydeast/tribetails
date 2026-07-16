package com.kinfolk.portal.auth

/** Android's native Firebase SDK handles attestation itself — nothing to wait for. */
actual suspend fun awaitRecaptchaReady(timeoutMs: Long) = Unit
