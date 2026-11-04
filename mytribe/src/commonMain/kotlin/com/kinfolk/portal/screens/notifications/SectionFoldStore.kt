package com.kinfolk.portal.screens.notifications

import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json

/**
 * Which Notification settings sections this device has folded shut (#1545).
 *
 * Only collapsed ids are stored, so a section the catalog adds later opens
 * expanded, the default. The screen takes this as a parameter so a test can
 * hand it an in-memory store: the real one below survives app restarts and,
 * on the JVM, outlives one test and would leak a fold into the next.
 */
interface SectionFoldStore {
    fun load(): Set<String>
    fun save(collapsed: Set<String>)
}

/**
 * Per-device persistence for the raw value, mirroring BusinessPublicCardStore:
 * SharedPreferences on Android, the JVM user preferences node on desktop, and
 * localStorage on web under the same key the React portal uses
 * (`notificationSettings:collapsedSections`), so each survives a restart.
 */
expect object SectionFoldStorage {
    fun load(): String?
    fun save(raw: String)
}

/** The store the shipping clients use: a JSON array of section ids. */
object DeviceSectionFoldStore : SectionFoldStore {
    private val ids = ListSerializer(String.serializer())

    override fun load(): Set<String> = runCatching {
        val raw = SectionFoldStorage.load() ?: return emptySet()
        Json.decodeFromString(ids, raw).filter { it.isNotBlank() }.toSet()
    }.getOrDefault(emptySet())

    override fun save(collapsed: Set<String>) {
        runCatching { SectionFoldStorage.save(Json.encodeToString(ids, collapsed.sorted())) }
    }
}
