package com.tribetails.auntieos.web.data

private class JvmGpsTracker : GpsTracker {
    override fun start(
        sessionId: String,
        onPing: (Breadcrumb) -> Unit,
        onError: (String) -> Unit,
    ) {
        onError("Desktop GPS tracking not supported")
    }

    override fun stop() = Unit
}

actual fun createGpsTracker(client: FirestoreClient): GpsTracker = JvmGpsTracker()
