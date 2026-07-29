package com.tribetails.auntieos.location

import android.Manifest
import android.app.*
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.Location
import android.os.*
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import com.google.android.gms.location.*
import com.tribetails.auntieos.AuntieOSApp
import com.tribetails.auntieos.R
import com.tribetails.auntieos.config.MapboxConfig
import com.tribetails.auntieos.data.model.*
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
import com.tribetails.auntieos.util.AuntieLog
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

class LocationTrackingService : Service() {

    companion object {
        const val ACTION_START_TRACKING = "START_TRACKING"
        const val ACTION_STOP_TRACKING = "STOP_TRACKING"
        const val ACTION_PAUSE_TRACKING = "PAUSE_TRACKING"
        const val ACTION_RESUME_TRACKING = "RESUME_TRACKING"

        const val EXTRA_SESSION_ID = "session_id"
        const val EXTRA_KINFOLK_ID = "kinfolk_id"
        const val EXTRA_HOME_LOCATION = "home_location"

        private const val NOTIFICATION_ID = 2001
        private const val CHANNEL_ID = "location_tracking_channel"

        private val _currentRoute = MutableStateFlow<VisitRoute?>(null)
        val currentRoute: StateFlow<VisitRoute?> = _currentRoute.asStateFlow()

        private val _isTracking = MutableStateFlow(false)
        val isTracking: StateFlow<Boolean> = _isTracking.asStateFlow()
    }

    private lateinit var fusedLocationClient: FusedLocationProviderClient
    private lateinit var locationCallback: LocationCallback
    private lateinit var repository: AuntieRepository

    // W4-3: the visit's own lifecycle and GPS summary are KinCare domain; the
    // visit_routes and location_checkpoints writes this service also makes are
    // not, and stay on [repository] until the Location carve.
    private lateinit var kinCareRepository: KinCareRepository

    private var currentSessionId: String? = null
    private var currentKinfolkId: String? = null
    private var homeLocation: LocationPoint? = null

    private val routePoints = mutableListOf<LocationPoint>()
    private var isCurrentlyTracking = false
    private var trackingStartTime = 0L
    private var businessSettings: BusinessSettings? = null

    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val binder = LocationTrackingBinder()

    inner class LocationTrackingBinder : Binder() {
        fun getService(): LocationTrackingService = this@LocationTrackingService
    }

    override fun onCreate() {
        super.onCreate()
        AuntieLog.d("LocationTrackingService onCreate")
        fusedLocationClient = LocationServices.getFusedLocationProviderClient(this)
        repository = AuntieOSApp.instance.repository
        kinCareRepository = AuntieOSApp.instance.kinCareRepository

        createNotificationChannel()
        setupLocationCallback()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        AuntieLog.d("LocationTrackingService onStartCommand: ${intent?.action}")
        when (intent?.action) {
            ACTION_START_TRACKING -> {
                val sessionId = intent.getStringExtra(EXTRA_SESSION_ID) ?: return START_NOT_STICKY
                val kinfolkId = intent.getStringExtra(EXTRA_KINFOLK_ID) ?: return START_NOT_STICKY
                // AGP 9 deprecation: legacy getParcelableExtra(String) replaced
                // with type-safe getParcelableExtra(String, Class) on API 33+.
                val homeLocationData = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    intent.getParcelableExtra(EXTRA_HOME_LOCATION, Bundle::class.java)
                } else {
                    @Suppress("DEPRECATION")
                    intent.getParcelableExtra<Bundle>(EXTRA_HOME_LOCATION)
                }

                startTracking(sessionId, kinfolkId, homeLocationData?.let {
                    LocationPoint(
                        latitude = it.getDouble("lat"),
                        longitude = it.getDouble("lng")
                    )
                })
            }
            ACTION_STOP_TRACKING -> stopTracking()
            ACTION_PAUSE_TRACKING -> pauseTracking()
            ACTION_RESUME_TRACKING -> resumeTracking()
        }

        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder = binder

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Location Tracking",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Tracks your location during kin care visits"
                setShowBadge(false)
            }

            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.createNotificationChannel(channel)
        }
    }

    private fun setupLocationCallback() {
        locationCallback = object : LocationCallback() {
            override fun onLocationResult(locationResult: LocationResult) {
                super.onLocationResult(locationResult)

                if (!isCurrentlyTracking) return

                locationResult.lastLocation?.let { location ->
                    addLocationPoint(location)
                }
            }
        }
    }

    private fun startTracking(sessionId: String, kinfolkId: String, homeLocation: LocationPoint?) {
        AuntieLog.i("Starting location tracking session: $sessionId")
        serviceScope.launch {
            repository.getBusinessSettings().fold(
                onSuccess = { settings ->
                    businessSettings = settings

                    if (!settings.enableGPSTrackingForAllVisits) {
                        AuntieLog.w("GPS tracking is disabled in business settings")
                        stopSelf()
                        return@launch
                    }

                    if (!hasLocationPermissions()) {
                        AuntieLog.e("Location permissions missing for tracking")
                        stopSelf()
                        return@launch
                    }

                    currentSessionId = sessionId
                    currentKinfolkId = kinfolkId
                    this@LocationTrackingService.homeLocation = homeLocation

                    isCurrentlyTracking = true
                    trackingStartTime = System.currentTimeMillis()
                    routePoints.clear()

                    _isTracking.value = true

                    startForeground(NOTIFICATION_ID, createTrackingNotification())
                    startLocationUpdates()

                    val shell = VisitRoute(
                        kinCareSessionId = sessionId,
                        kinfolkId = kinfolkId,
                        startTime = getCurrentTimestamp(),
                        homeLocation = homeLocation
                    )
                    // Persist the route shell FIRST so the assigned id is available to
                    // every subsequent ARRIVAL/DEPARTURE checkpoint. Without this,
                    // checkpoints save with routeId="" and RouteViewerScreen returns
                    // zero results when querying whereEqualTo("routeId", id).
                    val savedId = repository.saveVisitRoute(shell).getOrElse { e ->
                        AuntieLog.e("Failed to persist route shell at startTracking - checkpoints may be orphaned", e)
                        ""
                    }
                    _currentRoute.value = shell.copy(id = savedId)
                },
                onFailure = { e ->
                    AuntieLog.e("Failed to get business settings for tracking", e)
                    stopSelf()
                }
            )
        }
    }

    private fun stopTracking() {
        AuntieLog.i("Stopping location tracking session: $currentSessionId")
        isCurrentlyTracking = false
        _isTracking.value = false

        stopLocationUpdates()

        serviceScope.launch {
            saveRoute()
        }

        _currentRoute.value = null
        // stopForeground(true) → STOP_FOREGROUND_REMOVE: semantically equivalent
        // (removes the foreground notification on stop). AGP 9 deprecation fix.
        stopForeground(Service.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun pauseTracking() {
        AuntieLog.d("Pausing location tracking")
        isCurrentlyTracking = false
        stopLocationUpdates()
        updateNotification("Tracking Paused")
    }

    private fun resumeTracking() {
        AuntieLog.d("Resuming location tracking")
        if (!hasLocationPermissions()) {
            AuntieLog.e("Cannot resume tracking: permissions lost")
            return
        }

        isCurrentlyTracking = true
        startLocationUpdates()
        updateNotification("Tracking Active")
    }

    private fun startLocationUpdates() {
        if (ActivityCompat.checkSelfPermission(
                this,
                Manifest.permission.ACCESS_FINE_LOCATION
            ) != PackageManager.PERMISSION_GRANTED
        ) {
            return
        }

        val priority = when (businessSettings?.trackingAccuracy) {
            TrackingAccuracy.HIGH -> Priority.PRIORITY_HIGH_ACCURACY
            TrackingAccuracy.MEDIUM -> Priority.PRIORITY_BALANCED_POWER_ACCURACY
            TrackingAccuracy.LOW -> Priority.PRIORITY_LOW_POWER
            null -> Priority.PRIORITY_HIGH_ACCURACY
        }

        val locationRequest = LocationRequest.Builder(
            priority,
            MapboxConfig.LOCATION_UPDATE_INTERVAL
        ).apply {
            setMinUpdateDistanceMeters(MapboxConfig.MIN_DISTANCE_FOR_UPDATE)
            setMinUpdateIntervalMillis(MapboxConfig.LOCATION_FASTEST_INTERVAL)
        }.build()

        AuntieLog.d("Requesting location updates with priority $priority")
        fusedLocationClient.requestLocationUpdates(
            locationRequest,
            locationCallback,
            Looper.getMainLooper()
        )
    }

    private fun stopLocationUpdates() {
        AuntieLog.d("Removing location updates")
        fusedLocationClient.removeLocationUpdates(locationCallback)
    }

    private fun addLocationPoint(location: Location) {
        val locationPoint = LocationPoint(
            latitude = location.latitude,
            longitude = location.longitude,
            altitude = location.altitude,
            accuracy = location.accuracy,
            timestamp = location.time,
            speed = location.speed,
            bearing = location.bearing
        )

        val lastPoint = routePoints.lastOrNull()
        if (lastPoint == null || lastPoint.distanceTo(locationPoint) >= MapboxConfig.MIN_DISTANCE_FOR_UPDATE) {
            routePoints.add(locationPoint)

            // GPS subcollection write - canonical storage per
            // [[bug-sprint-architecture-decisions]]. Routed through the app-scoped
            // BreadcrumbDispatcher which guarantees sequential drain, bounded buffer with
            // DROP_OLDEST overflow, and survival across service teardown. Drop count
            // surfaces via dispatcher.snapshotDroppedCount() for diagnostics.
            val sessionId = currentSessionId
            if (!sessionId.isNullOrBlank()) {
                AuntieOSApp.instance.breadcrumbDispatcher
                    .send(sessionId, locationPoint)
            }

            if (routePoints.size > MapboxConfig.MAX_ROUTE_POINTS) {
                val filtered = routePoints.filterIndexed { index, _ -> index % 2 == 0 }
                routePoints.clear()
                routePoints.addAll(filtered)
            }

            val currentRoute = _currentRoute.value
            if (currentRoute != null) {
                val stats = computeVisitRouteStats(routePoints)
                val updatedRoute = currentRoute.copy(
                    endTime         = getCurrentTimestamp(),
                    totalDistance   = stats.totalDistanceMeters,
                    totalDuration   = stats.totalDurationMs,
                    averageSpeed    = stats.averageSpeed,
                    maxSpeed        = stats.maxSpeed,
                )
                _currentRoute.value = updatedRoute
            }

            checkLocationEvents(locationPoint)
        }
    }

    private fun checkLocationEvents(currentLocation: LocationPoint) {
        val home = homeLocation ?: return
        val distanceToHome = currentLocation.distanceTo(home)

        val currentRoute = _currentRoute.value ?: return

        if (distanceToHome <= MapboxConfig.ARRIVAL_DETECTION_RADIUS && currentRoute.arrivalTime.isBlank()) {
            AuntieLog.i("Arrival detected at client home")
            val updatedRoute = currentRoute.copy(
                arrivalTime = getCurrentTimestamp(),
                visitVerified = true
            )
            _currentRoute.value = updatedRoute

            serviceScope.launch {
                saveCheckpoint(currentLocation, CheckpointType.ARRIVAL, "Arrived at client's home")
            }
        }

        if (distanceToHome > MapboxConfig.DEPARTURE_DETECTION_RADIUS &&
            currentRoute.arrivalTime.isNotBlank() &&
            currentRoute.departureTime.isBlank()) {

            AuntieLog.i("Departure detected from client home")
            val updatedRoute = currentRoute.copy(
                departureTime = getCurrentTimestamp()
            )
            _currentRoute.value = updatedRoute

            serviceScope.launch {
                saveCheckpoint(currentLocation, CheckpointType.DEPARTURE, "Left client's home")
            }
        }
    }

    private suspend fun saveRoute() {
        val route = _currentRoute.value ?: return
        val sessionId = currentSessionId
        AuntieLog.d("Saving final route data")

        val stats = computeVisitRouteStats(routePoints)
        val finalRoute = route.copy(
            endTime         = getCurrentTimestamp(),
            totalDistance   = stats.totalDistanceMeters,
            totalDuration   = stats.totalDurationMs,
            averageSpeed    = stats.averageSpeed,
            maxSpeed        = stats.maxSpeed,
        )

        repository.saveVisitRoute(finalRoute).fold(
            onSuccess = { routeId ->
                AuntieLog.i("Visit route saved: $routeId")
                if (!sessionId.isNullOrBlank()) {
                    kinCareRepository.patchKinCareSession(
                        sessionId,
                        mapOf("visitRouteId" to routeId)
                    ).onFailure { e ->
                        AuntieLog.e("Failed to backfill visitRouteId on session $sessionId", e)
                    }
                    // Bake the canonical GpsSummary onto the session doc - same shape
                    // the web side writes via saveSessionGpsSummary. MyTribe getMyVisits
                    // reads this so kinfolks get visit replay regardless of which client
                    // (Android vs web) drove the session.
                    kinCareRepository.saveSessionGpsSummary(sessionId, buildGpsSummary(finalRoute, routePoints))
                        .onFailure { e ->
                            AuntieLog.e("Failed to save session gpsSummary on $sessionId", e)
                        }
                }
            },
            onFailure = { e ->
                AuntieLog.e("Failed to save visit route", e)
            }
        )
    }

    /** Builds the AuntieOS-canonical GpsSummary from a VisitRoute. Down-samples
     *  the polyline to ≤1000 points to fit Firestore's per-doc 1MB cap. */
    private fun buildGpsSummary(route: VisitRoute, points: List<LocationPoint>): GpsSummary {
        if (points.isEmpty()) {
            return GpsSummary(computedAt = getCurrentTimestamp())
        }
        val first = points.first()
        val last = points.last()
        return GpsSummary(
            distanceMeters  = route.totalDistance,
            durationSeconds = route.totalDuration / 1000L,
            startLat        = first.latitude,
            startLng        = first.longitude,
            endLat          = last.latitude,
            endLng          = last.longitude,
            route           = downsamplePoints(points, 1000),
            computedAt      = getCurrentTimestamp(),
        )
    }

    private fun downsamplePoints(pts: List<LocationPoint>, target: Int): List<GpsPoint> {
        if (pts.size <= target) {
            return pts.map { GpsPoint(lat = it.latitude, lng = it.longitude, t = it.timestamp) }
        }
        val step = pts.size.toDouble() / target.toDouble()
        val out = ArrayList<GpsPoint>(target)
        var i = 0.0
        while (out.size < target && i.toInt() < pts.size) {
            val p = pts[i.toInt()]
            out.add(GpsPoint(lat = p.latitude, lng = p.longitude, t = p.timestamp))
            i += step
        }
        // Always include the last point so the polyline ends where Auntie finished.
        val tail = pts.last()
        if (out.lastOrNull()?.t != tail.timestamp) {
            out.add(GpsPoint(lat = tail.latitude, lng = tail.longitude, t = tail.timestamp))
        }
        return out
    }

    private suspend fun saveCheckpoint(location: LocationPoint, type: CheckpointType, description: String) {
        val checkpoint = LocationCheckpoint(
            routeId = _currentRoute.value?.id ?: "",
            location = location,
            checkpointType = type,
            description = description,
            timestamp = getCurrentTimestamp()
        )

        repository.saveLocationCheckpoint(checkpoint).onFailure { e ->
            AuntieLog.e("Failed to save location checkpoint", e)
        }
    }

    private fun createTrackingNotification(): Notification {
        val stopIntent = Intent(this, LocationTrackingService::class.java).apply {
            action = ACTION_STOP_TRACKING
        }
        val stopPendingIntent = PendingIntent.getService(
            this, 0, stopIntent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val pauseIntent = Intent(this, LocationTrackingService::class.java).apply {
            action = ACTION_PAUSE_TRACKING
        }
        val pausePendingIntent = PendingIntent.getService(
            this, 1, pauseIntent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Tracking Kin Care Visit")
            .setContentText("Recording route for client transparency")
            .setSmallIcon(R.drawable.ic_location_on)
            .setOngoing(true)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .addAction(R.drawable.ic_pause, "Pause", pausePendingIntent)
            .addAction(R.drawable.ic_stop, "Stop", stopPendingIntent)
            .build()
    }

    private fun updateNotification(text: String) {
        val notification = createTrackingNotification()
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.notify(NOTIFICATION_ID, notification)
    }

    private fun hasLocationPermissions(): Boolean {
        return ActivityCompat.checkSelfPermission(
            this,
            Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED
    }

    private fun getCurrentTimestamp(): String {
        return java.time.Instant.now().toString()
    }

    override fun onDestroy() {
        AuntieLog.d("LocationTrackingService onDestroy")
        super.onDestroy()
        stopLocationUpdates()
        serviceScope.cancel()
    }
}
