package com.tribetails.auntieos.web.screens.communicate

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Pure builder for the sendExternalMessage callable payload. Subject is included
 * only for email with a non-blank value (matches the server). `transactional`
 * marks a 1:1 reply (Inbox/Messaging) so the server skips the marketing
 * suppression gate; false (default) is one-off outreach that honors opt-outs.
 */
fun externalSendPayloadJson(
    channel: String,
    to: String,
    subject: String?,
    body: String,
    transactional: Boolean,
): String {
    val payload: JsonObject = buildJsonObject {
        put("channel", JsonPrimitive(channel))
        put("to", JsonPrimitive(to))
        if (channel == "email" && !subject.isNullOrBlank()) put("subject", JsonPrimitive(subject))
        put("body", JsonPrimitive(body))
        put("transactional", JsonPrimitive(transactional))
    }
    return Json.encodeToString(JsonObject.serializer(), payload)
}
