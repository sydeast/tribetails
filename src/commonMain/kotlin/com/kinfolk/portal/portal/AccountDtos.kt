package com.kinfolk.portal.portal

data class Account(
    val uid: String,
    val email: String?,
    val displayName: String?,
    val phone: String?,
    /** Cloudinary or any HTTPS image URL — surfaced in MyTribe AccountSettings. */
    val photoUrl: String?,
    val backupEmail: String?,
    val backupPhone: String?,
    val kinfolkIds: List<String>,
    val hasPaymentMethod: Boolean,
    val updatedAtMs: Long?,
)

/**
 * Hybrid notification prefs. Mirrors functions/src/notifications/types.ts
 * UserNotificationPrefs.
 *
 *  byCategory     — category-level select-all defaults (UI row toggle)
 *  byKey          — per-notification granular override (UI expand)
 *  marketingOptIn — per marketingCategory (newsletter/survey/marketing) consent
 *
 * Effective channel resolution lives in Functions; UI just reads/writes raw map.
 */
data class NotificationPrefs(
    val byCategory: Map<String, Map<String, Boolean>>,
    val byKey: Map<String, Map<String, Boolean>>,
    val marketingOptIn: Map<String, Boolean>,
    val updatedAtMs: Long?,
)
