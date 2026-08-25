package com.tribetails.auntieos.location

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import androidx.core.app.ActivityCompat
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.android.gms.tasks.CancellationTokenSource
import com.tribetails.auntieos.util.AuntieLog
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withTimeout

/**
 * ISSUE #582: one location fix, taken at the moment "Arrived" is pressed.
 *
 * SEPARATE FROM [LocationTrackingService] ON PURPOSE. That service is the
 * breadcrumb trail: a foreground service, a notification, a watch that runs for
 * the length of a visit, and — crucially — gated on the operator's
 * `enableGPSTrackingForAllVisits` master switch. The arrival check is a
 * different question under a different switch
 * (`requireArrivalDepartureVerification`), and an operator who has turned route
 * tracking off has not thereby asked for arrivals to stop being verified.
 * Reusing the tracker would have tied the two together.
 *
 * NULL IS A NORMAL ANSWER, not an error path. Permission denied, location
 * services off, no fix indoors inside the timeout, a device with no GPS at all:
 * every one of them returns null, the arrival is unaffected, and the visit
 * completes later recorded as unverified. Nothing here can fail an arrival.
 */

/** A single fix. [accuracyMeters] is the device's own error radius, null when it did not report one. */
data class ArrivalFix(
    val lat: Double,
    val lng: Double,
    val accuracyMeters: Double?,
)

/** Where an arrival fix comes from. An interface so the ViewModel is testable off-device. */
interface ArrivalFixProvider {
    /** The device's current position, or null when one cannot be had. Never throws. */
    suspend fun currentFix(): ArrivalFix?
}

/**
 * How long to wait for a fix before giving up.
 *
 * Eight seconds. The Auntie is standing at a door waiting for the card to
 * settle, and a check that holds the screen longer than that will be worked
 * around rather than waited for. Giving up early costs the verification on one
 * arrival; holding the UI costs the feature.
 */
private const val FIX_TIMEOUT_MS = 8_000L

class FusedArrivalFixProvider(private val context: Context) : ArrivalFixProvider {

    private fun hasPermission(): Boolean =
        ActivityCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED ||
            ActivityCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

    override suspend fun currentFix(): ArrivalFix? {
        if (!hasPermission()) {
            // Not an error and not worth a prompt here: the Auntie is mid-visit
            // and the arrival has already landed.
            AuntieLog.i("Arrival check: no location permission, arrival stays unverified")
            return null
        }
        val cancellation = CancellationTokenSource()
        return try {
            // A CURRENT fix, not the last known one. `getLastLocation` would
            // happily hand back where the phone was at the previous house, which
            // is precisely the wrong answer to hand a distance check.
            val location = withTimeout(FIX_TIMEOUT_MS) {
                LocationServices.getFusedLocationProviderClient(context)
                    .getCurrentLocation(Priority.PRIORITY_HIGH_ACCURACY, cancellation.token)
                    .await()
            }
            location?.let {
                ArrivalFix(
                    lat = it.latitude,
                    lng = it.longitude,
                    accuracyMeters = if (it.hasAccuracy()) it.accuracy.toDouble() else null,
                )
            }
        } catch (e: TimeoutCancellationException) {
            cancellation.cancel()
            AuntieLog.i("Arrival check: no fix within ${FIX_TIMEOUT_MS}ms, arrival stays unverified")
            null
        } catch (e: SecurityException) {
            // Permission revoked between the check above and the call.
            AuntieLog.i("Arrival check: location permission withdrawn, arrival stays unverified")
            null
        } catch (e: Exception) {
            AuntieLog.e("Arrival check: could not take a location fix", e)
            null
        }
    }
}
