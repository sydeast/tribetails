package com.kinfolk.portal.portal

/**
 * MyTribe client-portal configuration. Shared wire contract across the AuntieOS
 * `MyTribePortalConfig` model and the getMyHome Function `PortalConfig` —
 * field names/types/defaults MUST match byte-for-byte on all three sides.
 *
 * Sourced from getMyHome's `portal` object; every field is defaulted so a
 * settings doc without `mytribePortal` yields the canonical defaults.
 */
data class PortalConfig(
    val logoUrl: String = "",
    val themeId: String = "default",
    val banner: PortalBanner = PortalBanner(),
    val home: List<PortalHomeSection> = emptyList(),
    val chat: PortalChat = PortalChat(),
)

data class PortalBanner(
    val enabled: Boolean = false,
    val message: String = "",
    val tone: String = "info",
    val dismissMode: String = "none",
    val id: String = "",
)

/** A single home section's config. `limit` 0 = unlimited. */
data class PortalHomeSection(
    val id: String = "",
    val enabled: Boolean = true,
    val limit: Int = 0,
)

data class PortalChat(
    val enabled: Boolean = true,
    val awayMessage: String = "",
    val hoursEnabled: Boolean = false,
    val hours: Map<String, String> = emptyMap(),
    val maxMessageLength: Int = 2000,
    val rateLimitPerHour: Int = 0,
)
