package com.tribetails.auntieos.data.admin

import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.PUT
import retrofit2.http.Query

interface AdminApiService {
    
    // Auth
    @POST("admin/login")
    suspend fun login(@Body request: Map<String, String>): Map<String, String>
    
    @POST("admin/forgot-password")
    suspend fun forgotPassword(@Body request: Map<String, String>)

    // Dashboard & Schedule
    @GET("admin/events")
    suspend fun getEvents(
        @Query("startDate") startDate: String,
        @Query("endDate") endDate: String,
        @Query("filterType") filterType: String? = null
    ): List<Event>

    @GET("admin/kincare/upcoming")
    suspend fun getUpcomingKinCare(@Query("limit") limit: Int = 5): List<Event>

    // Scheduling availability + sync
    @POST("admin/scheduling/availability")
    suspend fun checkAvailability(@Body request: AvailabilityRequest): AvailabilityResponse

    @POST("admin/scheduling/waitlist")
    suspend fun joinWaitlist(@Body request: WaitlistRequest)

    @POST("admin/scheduling/sync/google-busy")
    suspend fun syncGoogleBusyBlocks(@Body request: GoogleBusySyncRequest): GoogleBusySyncResponse

    // Profile Settings
    @GET("admin/profile")
    suspend fun getProfile(): AdminProfile

    @PUT("admin/profile")
    suspend fun updateProfile(@Body profile: AdminProfile): AdminProfile

    // Activity Log
    @GET("admin/activity-logs")
    suspend fun getActivityLogs(
        @Query("page") page: Int,
        @Query("pageSize") pageSize: Int = 50
    ): List<ActivityLogEntry>
}

data class AvailabilityRequest(
    val kinfolkId: String,
    val startDateTime: String,
    val endDateTime: String,
    val requestedDurationMinutes: Int,
    val transportationAddonSelected: Boolean = false
)

data class AvailabilitySuggestion(
    val startDateTime: String,
    val endDateTime: String,
    val reason: String
)

data class AvailabilityResponse(
    val available: Boolean,
    val message: String,
    val nextOptions: List<AvailabilitySuggestion> = emptyList(),
    val showWaitlist: Boolean = false
)

data class WaitlistRequest(
    val kinfolkId: String,
    val requestedStartDateTime: String,
    val requestedEndDateTime: String,
    val note: String = ""
)

data class GoogleBusySyncRequest(
    val lookAheadDays: Int = 30
)

data class GoogleBusySyncResponse(
    val importedCount: Int,
    val updatedCount: Int,
    val ignoredCount: Int
)

