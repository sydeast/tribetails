package com.kinfolk.portal.share
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
class SharedTaleTitleTest {
    private fun payload(json: String) = Json.parseToJsonElement(json).jsonObject
    @Test
    fun titledShare_readsTheTrimmedTitle() {
        assertEquals("Biscuit at the beach", sharedTaleTitle(payload("""{"title":"  Biscuit at the beach ","body":"hi"}""")))
    }
    @Test
    fun olderShareWithNoTitle_isNull() {
        assertNull(sharedTaleTitle(payload("""{"authorDisplayName":"Maya","body":"hi"}""")))
    }
    @Test
    fun blankOrMalformedTitle_isNull() {
        assertNull(sharedTaleTitle(payload("""{"title":"   "}""")))
        assertNull(sharedTaleTitle(payload("""{"title":["x"]}""")))
    }
}
