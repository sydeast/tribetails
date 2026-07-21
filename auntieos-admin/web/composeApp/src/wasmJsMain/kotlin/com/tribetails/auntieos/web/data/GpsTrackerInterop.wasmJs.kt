package com.tribetails.auntieos.web.data

import com.tribetails.auntieos.web.util.nowIso
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

@JsFun(
    """
    (cb) => {
      if (!navigator || !navigator.geolocation) { cb('unsupported'); return -1; }
      const ok = (p) => {
        const c = p.coords;
        const h = (c.heading === null || c.heading === undefined || isNaN(c.heading)) ? -1 : c.heading;
        const s = (c.speed   === null || c.speed   === undefined || isNaN(c.speed))   ? -1 : c.speed;
        cb('ok:' + c.latitude + ',' + c.longitude + ',' + (c.accuracy || 0) + ',' + h + ',' + s);
      };
      const err = (e) => {
        const m = e && e.code === 1 ? 'permission_denied'
                : e && e.code === 2 ? 'position_unavailable'
                : e && e.code === 3 ? 'timeout'
                : 'geolocation_error';
        cb('err:' + m + (e && e.message ? ':' + e.message : ''));
      };
      return navigator.geolocation.watchPosition(ok, err, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
    }
    """
)
private external fun jsWatchPosition(cb: (String) -> Unit): Int

@JsFun("(id) => { if (navigator && navigator.geolocation && id >= 0) navigator.geolocation.clearWatch(id); }")
private external fun jsClearWatch(id: Int)

private const val THROTTLE_MS = 5_000L

private class WasmGpsTracker(private val client: FirestoreClient) : GpsTracker {
    private var watchId: Int = -1
    private var scope: CoroutineScope? = null
    private var lastEmitMs: Long = 0L

    override fun start(
        sessionId: String,
        onPing: (Breadcrumb) -> Unit,
        onError: (String) -> Unit,
    ) {
        if (watchId >= 0) return
        val newScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        scope = newScope
        lastEmitMs = 0L

        val id = jsWatchPosition { payload ->
            when {
                payload == "unsupported" -> {
                    onError("Browser does not support geolocation")
                    stop()
                }
                payload.startsWith("err:") -> {
                    onError(payload.removePrefix("err:"))
                    if (payload.startsWith("err:permission_denied")) stop()
                }
                payload.startsWith("ok:") -> {
                    val now = nowMs()
                    if (now - lastEmitMs < THROTTLE_MS) return@jsWatchPosition
                    lastEmitMs = now
                    val parts = payload.removePrefix("ok:").split(",")
                    if (parts.size < 5) return@jsWatchPosition
                    val crumb = Breadcrumb(
                        timestamp = nowIso(),
                        lat = parts[0].toDoubleOrNull() ?: return@jsWatchPosition,
                        lng = parts[1].toDoubleOrNull() ?: return@jsWatchPosition,
                        accuracyMeters = parts[2].toDoubleOrNull() ?: 0.0,
                        headingDegrees = parts[3].toDoubleOrNull() ?: -1.0,
                        speedMetersPerSec = parts[4].toDoubleOrNull() ?: -1.0,
                    )
                    onPing(crumb)
                    newScope.launch {
                        when (val r = client.addBreadcrumb(sessionId, crumb)) {
                            is WriteResult.Err -> onError("Breadcrumb write failed: ${r.message}")
                            is WriteResult.Ok -> Unit
                        }
                    }
                }
            }
        }
        if (id == -1) {
            scope = null
            newScope.cancel()
            return
        }
        watchId = id
    }

    override fun stop() {
        if (watchId >= 0) {
            jsClearWatch(watchId)
            watchId = -1
        }
        scope?.cancel()
        scope = null
    }
}

@JsFun("() => Date.now()")
private external fun jsNowMs(): Double

private fun nowMs(): Long = jsNowMs().toLong()

actual fun createGpsTracker(client: FirestoreClient): GpsTracker = WasmGpsTracker(client)
