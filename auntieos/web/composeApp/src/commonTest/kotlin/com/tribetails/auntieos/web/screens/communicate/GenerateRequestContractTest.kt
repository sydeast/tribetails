package com.tribetails.auntieos.web.screens.communicate

import com.tribetails.auntieos.web.data.CommunicationType
import com.tribetails.auntieos.web.data.GenerateRequest
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The generate action's wire contract. It must stay byte-compatible with the n8n
 * webhook AND the new /api/generate Function: communication_type serializes to the
 * snake-case string the backend reads, and avoid_opening rides along on regenerate
 * (omitted when null, present when set). Same Json config as N8nClient's codec.
 */
class GenerateRequestContractTest {
    private val codec = Json { ignoreUnknownKeys = true; isLenient = true }

    @Test
    fun communicationTypeSerializesToSnakeAndOmitsNullAvoidOpening() {
        val s = codec.encodeToString(
            GenerateRequest(
                communication_type = CommunicationType.VISIT_REPORT,
                recipient = "Dana",
                raw_notes = "fed the cats",
            ),
        )
        assertContains(s, "\"communication_type\":\"visit_report\"")
        assertContains(s, "\"recipient\":\"Dana\"")
        assertContains(s, "\"raw_notes\":\"fed the cats\"")
        assertFalse(s.contains("avoid_opening"), "null avoid_opening must be omitted: $s")
    }

    @Test
    fun avoidOpeningRidesAlongOnRegenerate() {
        val s = codec.encodeToString(
            GenerateRequest(
                communication_type = CommunicationType.SMS,
                recipient = "Nora",
                raw_notes = "quick update",
                avoid_opening = "Well",
            ),
        )
        assertContains(s, "\"communication_type\":\"sms\"")
        assertContains(s, "\"avoid_opening\":\"Well\"")
    }

    @Test
    fun everyCommunicationTypeHasAStableSerialName() {
        // The Function's ALLOWED set + the n8n switch both key off these exact strings.
        val expected = mapOf(
            CommunicationType.SMS to "sms",
            CommunicationType.EMAIL to "email",
            CommunicationType.VISIT_REPORT to "visit_report",
            CommunicationType.SOCIAL_POST to "social_post",
            CommunicationType.BLOG_POST to "blog_post",
            CommunicationType.GENERAL to "general",
        )
        for ((type, name) in expected) {
            val s = codec.encodeToString(
                GenerateRequest(communication_type = type, recipient = "x", raw_notes = "y"),
            )
            assertTrue(s.contains("\"communication_type\":\"$name\""), "$type must serialize to $name: $s")
        }
    }
}
