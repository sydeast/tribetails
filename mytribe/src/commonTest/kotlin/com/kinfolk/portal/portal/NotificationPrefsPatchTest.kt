package com.kinfolk.portal.portal
import com.kinfolk.portal.notifications.NotificationChannel
import com.kinfolk.portal.notifications.NotificationKey
import com.kinfolk.portal.screens.notifications.keyDescriptionLine
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
class NotificationPrefsPatchTest {
    @Test
    fun toJson_namesOnlyWhatChanged() {
        val json = NotificationPrefsPatch(byCategory = mapOf("visit" to mapOf("sms" to true))).toJson()
        assertEquals(setOf("byCategory"), json.keys)
        assertEquals(true, json["byCategory"]!!.jsonObject["visit"]!!.jsonObject["sms"]!!.jsonPrimitive.booleanOrNull)
    }
    @Test
    fun toJson_sendsNullToClearAnOverrideAndAKey() {
        val json = NotificationPrefsPatch(
            byKey = mapOf<String, Map<String, Boolean?>?>("a" to mapOf<String, Boolean?>("sms" to null), "b" to null),
        ).toJson()
        val byKey = json["byKey"]!!.jsonObject
        assertEquals(JsonNull, byKey["a"]!!.jsonObject["sms"])
        assertEquals(JsonNull, byKey["b"])
    }
    @Test
    fun apply_mergesPerChannelAndLeavesTheRestAlone() {
        val byCategory = mutableMapOf("visit" to mutableMapOf("email" to true, "sms" to false), "invoice" to mutableMapOf("email" to true))
        val byKey = mutableMapOf("k" to mutableMapOf("push" to false))
        val marketing = mutableMapOf("newsletter" to true)
        applyNotificationPrefsPatch(
            NotificationPrefsPatch(byCategory = mapOf("visit" to mapOf("sms" to true))),
            byCategory, byKey, marketing,
        )
        assertEquals<Map<String, Boolean>?>(mapOf("email" to true, "sms" to true), byCategory["visit"])
        assertEquals<Map<String, Boolean>?>(mapOf("email" to true), byCategory["invoice"])
        assertEquals<Map<String, Boolean>?>(mapOf("push" to false), byKey["k"])
        assertEquals<Map<String, Boolean>?>(mapOf("newsletter" to true), marketing)
    }
    @Test
    fun apply_nullClearsOneOverrideAndTheLastOneRemovesTheEntry() {
        val byKey = mutableMapOf("k" to mutableMapOf("sms" to true, "push" to false))
        applyNotificationPrefsPatch(NotificationPrefsPatch(byKey = mapOf<String, Map<String, Boolean?>?>("k" to mapOf<String, Boolean?>("sms" to null))), mutableMapOf(), byKey, mutableMapOf())
        assertEquals<Map<String, Boolean>?>(mapOf("push" to false), byKey["k"])
        applyNotificationPrefsPatch(NotificationPrefsPatch(byKey = mapOf<String, Map<String, Boolean?>?>("k" to mapOf<String, Boolean?>("push" to null))), mutableMapOf(), byKey, mutableMapOf())
        assertFalse(byKey.containsKey("k"))
    }
    @Test
    fun apply_nullKeyEntryClearsEveryOverrideOnTheKey_andMarketingMerges() {
        val byKey = mutableMapOf("k" to mutableMapOf("sms" to true), "j" to mutableMapOf("sms" to true))
        val marketing = mutableMapOf("newsletter" to true)
        applyNotificationPrefsPatch(
            NotificationPrefsPatch(byKey = mapOf<String, Map<String, Boolean?>?>("k" to null), marketingOptIn = mapOf("survey" to true)),
            mutableMapOf(), byKey, marketing,
        )
        assertNull(byKey["k"])
        assertEquals<Map<String, Boolean>?>(mapOf("sms" to true), byKey["j"])
        assertEquals<Map<String, Boolean>?>(mapOf("newsletter" to true, "survey" to true), marketing)
    }
    private fun key(title: String, description: String) = NotificationKey(
        key = "k", title = title, description = description,
        allowedChannels = setOf(NotificationChannel.EMAIL),
        required = emptySet(), lockedChannels = emptySet(),
    )
    @Test
    fun keyDescriptionLine_dropsADescriptionThatOnlyRepeatsTheTitle() {
        assertNull(keyDescriptionLine(key("KinCare booking confirmed", "KinCare booking confirmed.")))
        assertNull(keyDescriptionLine(key("Invoice overdue", " invoice overdue! ")))
        assertEquals("Receipt issued for an invoice.", keyDescriptionLine(key("Receipt", "Receipt issued for an invoice.")))
    }
}
