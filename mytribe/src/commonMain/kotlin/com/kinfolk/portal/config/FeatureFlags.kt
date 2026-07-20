package com.kinfolk.portal.config

/**
 * Client feature flags for MyTribe.
 *
 * All `mytribe.*` flags have been removed: every previously gated feature now
 * ships as normal always-on behavior. This type is intentionally empty but kept
 * so the [LocalFeatureFlags] ambient and the
 * [com.kinfolk.portal.portal.PortalApi.getFeatureFlags] plumbing still compile.
 * Any remote `getFeatureFlags` payload is ignored (unknown keys never produce
 * surprise behavior).
 */
data class FeatureFlags(
    val unused: Unit = Unit,
) {
    fun toMap(): Map<String, Boolean> = emptyMap()

    companion object {
        /** Compile-time safe baseline. */
        val DEFAULT = FeatureFlags()

        /** Every flag key the client understands. None remain. */
        val KEYS: List<String> = emptyList()

        fun fromMap(m: Map<String, Boolean>): FeatureFlags = FeatureFlags()

        fun fromOverrides(o: Map<String, Boolean>): FeatureFlags = FeatureFlags()

        fun resolve(g: Map<String, Boolean>, p: Map<String, Boolean>): FeatureFlags = FeatureFlags()
    }
}
