package com.kinfolk.portal.portal
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
/**
 * One notification-preference change (#1292). The portal saves each toggle the
 * moment it is tapped, and the patch names only what that tap changed. The
 * server merges it into the stored preferences (functions/src/notifications/
 * prefsSchema.ts applyPrefsPatch), so a save can never rewrite a choice made on
 * another device.
 *
 *  - [byCategory]: category -> channel -> value, merged per channel.
 *  - [byKey]: key -> channel -> value sets an override; a null channel value
 *    clears that override (back to following the category); a null key entry
 *    clears every override on the key.
 *  - [marketingOptIn]: marketing category -> value, merged.
 */
data class NotificationPrefsPatch(
    val byCategory: Map<String, Map<String, Boolean>> = emptyMap(),
    val byKey: Map<String, Map<String, Boolean?>?> = emptyMap(),
    val marketingOptIn: Map<String, Boolean> = emptyMap(),
) {
    fun toJson(): JsonObject = buildJsonObject {
        if (byCategory.isNotEmpty()) {
            put("byCategory", buildJsonObject {
                byCategory.forEach { (cat, channels) ->
                    put(cat, buildJsonObject { channels.forEach { (ch, v) -> put(ch, v) } })
                }
            })
        }
        if (byKey.isNotEmpty()) {
            put("byKey", buildJsonObject {
                byKey.forEach { (key, channels) ->
                    if (channels == null) {
                        put(key, JsonNull)
                    } else {
                        put(key, buildJsonObject {
                            channels.forEach { (ch, v) -> if (v == null) put(ch, JsonNull) else put(ch, v) }
                        })
                    }
                }
            })
        }
        if (marketingOptIn.isNotEmpty()) {
            put("marketingOptIn", buildJsonObject { marketingOptIn.forEach { (k, v) -> put(k, v) } })
        }
    }
}
/**
 * Apply a confirmed [patch] to the maps the screen renders from. The same merge
 * the server performs, so what is on screen after a save is what is stored.
 * Called only after the server answered ok (the screen is pessimistic).
 */
fun applyNotificationPrefsPatch(
    patch: NotificationPrefsPatch,
    byCategory: MutableMap<String, MutableMap<String, Boolean>>,
    byKey: MutableMap<String, MutableMap<String, Boolean>>,
    marketingOptIn: MutableMap<String, Boolean>,
) {
    patch.byCategory.forEach { (cat, channels) ->
        byCategory[cat] = (byCategory[cat]?.toMutableMap() ?: mutableMapOf()).also { it.putAll(channels) }
    }
    patch.byKey.forEach { (key, channels) ->
        if (channels == null) {
            byKey.remove(key)
            return@forEach
        }
        val next = byKey[key]?.toMutableMap() ?: mutableMapOf()
        channels.forEach { (ch, v) -> if (v == null) next.remove(ch) else next[ch] = v }
        if (next.isEmpty()) byKey.remove(key) else byKey[key] = next
    }
    marketingOptIn.putAll(patch.marketingOptIn)
}
