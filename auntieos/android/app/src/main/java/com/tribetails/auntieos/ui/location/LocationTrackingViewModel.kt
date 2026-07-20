package com.tribetails.auntieos.ui.location

import android.content.Context
import android.content.Intent
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tribetails.auntieos.data.model.*
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.location.LocationTrackingService
import com.tribetails.auntieos.util.AuntieLog
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class LocationTrackingUiState(
    val currentRoute: VisitRoute? = null,
    val checkpoints: List<LocationCheckpoint> = emptyList(),
    val isTracking: Boolean = false,
    val isLoading: Boolean = false,
    val error: String? = null,
    val locationPermissionGranted: Boolean = false,
    val sharingPreferences: LocationSharingPreferences? = null
)

class LocationTrackingViewModel(
    private val repository: AuntieRepository
) : ViewModel() {

    private val _uiState = MutableStateFlow(LocationTrackingUiState())
    val uiState: StateFlow<LocationTrackingUiState> = _uiState.asStateFlow()

    init {
        AuntieLog.d("LocationTrackingViewModel initialized")
        // Observe current tracking state from service
        viewModelScope.launch {
            LocationTrackingService.currentRoute.collect { route ->
                _uiState.value = _uiState.value.copy(currentRoute = route)
            }
        }

        viewModelScope.launch {
            LocationTrackingService.isTracking.collect { isTracking ->
                _uiState.value = _uiState.value.copy(isTracking = isTracking)
            }
        }
    }

    fun startLocationTracking(
        context: Context,
        sessionId: String,
        kinfolkId: String,
        homeLocation: LocationPoint?
    ) {
        AuntieLog.i("Starting location tracking for session: $sessionId, kinfolk: $kinfolkId")
        try {
            val intent = Intent(context, LocationTrackingService::class.java).apply {
                action = LocationTrackingService.ACTION_START_TRACKING
                putExtra(LocationTrackingService.EXTRA_SESSION_ID, sessionId)
                putExtra(LocationTrackingService.EXTRA_KINFOLK_ID, kinfolkId)
                homeLocation?.let {
                    val locationBundle = android.os.Bundle().apply {
                        putDouble("lat", it.latitude)
                        putDouble("lng", it.longitude)
                    }
                    putExtra(LocationTrackingService.EXTRA_HOME_LOCATION, locationBundle)
                }
            }
            context.startForegroundService(intent)
        } catch (e: Exception) {
            AuntieLog.e("Failed to start location tracking service", e)
            _uiState.value = _uiState.value.copy(error = "Could not start tracking service")
        }
    }

    fun stopLocationTracking(context: Context) {
        AuntieLog.i("Stopping location tracking")
        val intent = Intent(context, LocationTrackingService::class.java).apply {
            action = LocationTrackingService.ACTION_STOP_TRACKING
        }
        context.startService(intent)
    }

    fun pauseLocationTracking(context: Context) {
        AuntieLog.d("Pausing location tracking")
        val intent = Intent(context, LocationTrackingService::class.java).apply {
            action = LocationTrackingService.ACTION_PAUSE_TRACKING
        }
        context.startService(intent)
    }

    fun resumeLocationTracking(context: Context) {
        AuntieLog.d("Resuming location tracking")
        val intent = Intent(context, LocationTrackingService::class.java).apply {
            action = LocationTrackingService.ACTION_RESUME_TRACKING
        }
        context.startService(intent)
    }

    fun loadRoute(routeId: String) {
        AuntieLog.d("Loading route: $routeId")
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isLoading = true, error = null)

            repository.getVisitRoute(routeId).fold(
                onSuccess = { route ->
                    if (route != null) {
                        AuntieLog.d("Route $routeId loaded successfully")
                        _uiState.value = _uiState.value.copy(
                            currentRoute = route,
                            isLoading = false
                        )
                        // Load associated checkpoints
                        loadCheckpoints(routeId)
                    } else {
                        AuntieLog.w("Route $routeId not found")
                        _uiState.value = _uiState.value.copy(
                            isLoading = false,
                            error = "Route not found"
                        )
                    }
                },
                onFailure = { error ->
                    AuntieLog.e("Failed to load route $routeId", error)
                    _uiState.value = _uiState.value.copy(
                        isLoading = false,
                        error = "Failed to load route: ${error.message}"
                    )
                }
            )
        }
    }

    private fun loadCheckpoints(routeId: String) {
        AuntieLog.d("Loading checkpoints for route: $routeId")
        viewModelScope.launch {
            repository.getCheckpointsForRoute(routeId).fold(
                onSuccess = { checkpoints ->
                    AuntieLog.d("Loaded ${checkpoints.size} checkpoints for route $routeId")
                    _uiState.value = _uiState.value.copy(checkpoints = checkpoints)
                },
                onFailure = { error ->
                    AuntieLog.w("Failed to load checkpoints for route $routeId", error)
                }
            )
        }
    }

    fun loadRoutesForKinfolk(kinfolkId: String) {
        AuntieLog.d("Loading routes for kinfolk: $kinfolkId")
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isLoading = true, error = null)

            repository.getVisitRoutesForKinfolk(kinfolkId).fold(
                onSuccess = { routes ->
                    AuntieLog.d("Loaded ${routes.size} routes for kinfolk $kinfolkId")
                    _uiState.value = _uiState.value.copy(isLoading = false)
                },
                onFailure = { error ->
                    AuntieLog.e("Failed to load routes for kinfolk $kinfolkId", error)
                    _uiState.value = _uiState.value.copy(
                        isLoading = false,
                        error = "Failed to load routes: ${error.message}"
                    )
                }
            )
        }
    }

    fun loadLocationSharingPreferences(kinfolkId: String) {
        AuntieLog.d("Loading location sharing preferences for kinfolk: $kinfolkId")
        viewModelScope.launch {
            repository.getLocationSharingPreferences(kinfolkId).fold(
                onSuccess = { preferences ->
                    AuntieLog.d("Sharing preferences loaded for $kinfolkId")
                    _uiState.value = _uiState.value.copy(
                        sharingPreferences = preferences ?: LocationSharingPreferences(kinfolkId = kinfolkId)
                    )
                },
                onFailure = { error ->
                    AuntieLog.w("Failed to load sharing preferences for $kinfolkId, using defaults", error)
                    _uiState.value = _uiState.value.copy(
                        sharingPreferences = LocationSharingPreferences(kinfolkId = kinfolkId)
                    )
                }
            )
        }
    }

    fun updateLocationSharingPreferences(preferences: LocationSharingPreferences) {
        AuntieLog.i("Updating location sharing preferences for kinfolk: ${preferences.kinfolkId}")
        viewModelScope.launch {
            repository.saveLocationSharingPreferences(preferences).fold(
                onSuccess = {
                    AuntieLog.d("Sharing preferences saved successfully")
                    _uiState.value = _uiState.value.copy(sharingPreferences = preferences)
                },
                onFailure = { error ->
                    AuntieLog.e("Failed to save sharing preferences", error)
                    _uiState.value = _uiState.value.copy(
                        error = "Failed to save preferences: ${error.message}"
                    )
                }
            )
        }
    }

    fun setLocationPermissionGranted(granted: Boolean) {
        AuntieLog.d("Location permission granted set to: $granted")
        _uiState.value = _uiState.value.copy(locationPermissionGranted = granted)
    }

    fun clearError() {
        _uiState.value = _uiState.value.copy(error = null)
    }

    fun getCurrentTrackingStats(): VisitLocationSummary? {
        val route = _uiState.value.currentRoute ?: return null

        return VisitLocationSummary(
            visitDuration = if (route.arrivalTime.isNotBlank() && route.departureTime.isNotBlank()) {
                try {
                    val arrivalTime = java.time.Instant.parse(route.arrivalTime).toEpochMilli()
                    val departureTime = java.time.Instant.parse(route.departureTime).toEpochMilli()
                    departureTime - arrivalTime
                } catch (e: Exception) {
                    AuntieLog.w("Failed to parse arrival/departure time for visit stats", e)
                    0L
                }
            } else 0L,
            walkDistance = route.totalDistance,
            walkDuration = route.totalDuration,
            averageWalkingSpeed = route.averageSpeed,
            homeArrivalVerified = route.arrivalTime.isNotBlank(),
            homeDepartureVerified = route.departureTime.isNotBlank(),
            photoLocations = _uiState.value.checkpoints.count { it.checkpointType == CheckpointType.PHOTO_STOP }
        )
    }
}
