package com.tribetails.auntieos.web.data

/**
 * Live GPS breadcrumb tracker. wasmJs binds `navigator.geolocation.watchPosition`
 * and posts each ping to `kin_care_sessions/{sessionId}/breadcrumbs` via
 * [FirestoreClient.addBreadcrumb]. Pings are throttled to >=5s spacing
 * client-side because watchPosition fires on any movement.
 *
 * Fail-loud per project policy: permission denial or unsupported browser
 * surfaces via [onError]; never silently swallow.
 */
interface GpsTracker {
    fun start(
        sessionId: String,
        onPing: (Breadcrumb) -> Unit,
        onError: (String) -> Unit,
    )

    fun stop()
}

expect fun createGpsTracker(client: FirestoreClient): GpsTracker
