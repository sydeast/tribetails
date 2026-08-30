package com.tribetails.auntieos.data.model

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Parity guard for [decodeHomeSections] / [encodeHomeSections] against the
 * shared wire contract: `HomeSectionCfg` (React admin `src/api/settings.ts`)
 * and `PortalHomeSection` (mytribe/functions/src/portal/getMyHome.ts). Same
 * Class A drop-rules posture as [TagVocabDecodeTest]: a malformed row is
 * dropped, never thrown, because a hand-edited doc must never blank the whole
 * settings read.
 */
class PortalHomeSectionTest {

    private fun row(id: Any?, enabled: Any?, limit: Any?): Map<String, Any?> =
        mapOf("id" to id, "enabled" to enabled, "limit" to limit)

    private fun portal(sections: List<Any?>): Map<String, Any?> =
        mapOf("home" to mapOf("sections" to sections))

    // ── Decode ───────────────────────────────────────────────────────────────

    @Test fun `decodes a well-formed row`() {
        val out = decodeHomeSections(portal(listOf(row("upNext", true, 5))))
        assertEquals(listOf(PortalHomeSection("upNext", true, 5)), out)
    }

    @Test fun `preserves row order -- order IS the persisted layout`() {
        val out = decodeHomeSections(
            portal(listOf(row("roster", true, 0), row("upNext", false, 3), row("tales", true, 0)))
        )
        assertEquals(listOf("roster", "upNext", "tales"), out.map { it.id })
    }

    @Test fun `a limit stored as a Long or Double still decodes as an Int`() {
        assertEquals(5, decodeHomeSections(portal(listOf(row("upNext", true, 5L)))).single().limit)
        assertEquals(5, decodeHomeSections(portal(listOf(row("upNext", true, 5.0)))).single().limit)
    }

    @Test fun `a missing enabled or limit defaults rather than drops the row`() {
        val out = decodeHomeSections(portal(listOf(mapOf("id" to "upNext"))))
        assertEquals(listOf(PortalHomeSection("upNext", enabled = true, limit = 0)), out)
    }

    @Test fun `a non-String id defaults to blank rather than dropping the row`() {
        val out = decodeHomeSections(portal(listOf(row(7, true, 0))))
        assertEquals(listOf(PortalHomeSection("", true, 0)), out)
    }

    @Test fun `mytribePortal not a map, home not a map, or sections not a list all decode to empty`() {
        assertEquals(emptyList<PortalHomeSection>(), decodeHomeSections(null))
        assertEquals(emptyList<PortalHomeSection>(), decodeHomeSections("mytribePortal"))
        assertEquals(emptyList<PortalHomeSection>(), decodeHomeSections(mapOf("home" to "not-a-map")))
        assertEquals(emptyList<PortalHomeSection>(), decodeHomeSections(mapOf("home" to mapOf("sections" to "not-a-list"))))
        assertEquals(emptyList<PortalHomeSection>(), decodeHomeSections(emptyMap<String, Any?>()))
    }

    @Test fun `drops a row that is not a map, keeping the well-formed ones`() {
        val out = decodeHomeSections(portal(listOf("upNext", null, 7, row("roster", true, 0))))
        assertEquals(listOf("roster"), out.map { it.id })
    }

    @Test fun `never throws on a fully hand-mangled sections list`() {
        // Only non-Map entries are dropped outright; a Map with no usable keys
        // still decodes (an id-less row, defaulted), which is why "roster" is
        // not the ONLY id in the result -- the point of this test is that
        // decoding a pile of garbage never throws, not that every row survives.
        val out = decodeHomeSections(portal(listOf(null, 1, "x", listOf("nested"), row("roster", true, 0))))
        assertEquals(listOf("roster"), out.map { it.id })
    }

    // ── Encode: patches home.sections, preserves every sibling key ───────────

    @Test fun `encodes sections under home, preserving id-enabled-limit shape`() {
        val encoded = encodeHomeSections(null, listOf(PortalHomeSection("upNext", true, 5)))
        val home = encoded["home"] as Map<*, *>
        val sections = home["sections"] as List<*>
        assertEquals(mapOf("id" to "upNext", "enabled" to true, "limit" to 5), sections.single())
    }

    @Test fun `a null raw mytribePortal encodes a fresh object with only home`() {
        val encoded = encodeHomeSections(null, emptyList())
        assertEquals(setOf("home"), encoded.keys)
    }

    /**
     * THE DIFF-NOT-REBUILD CASE. Android models none of `logoUrl` / `themeId` /
     * `banner` / `chat`; a save from here must leave them exactly as the React
     * admin last wrote them.
     */
    @Test fun `preserves every sibling key this client does not model`() {
        val raw = mapOf(
            "logoUrl" to "https://example.com/logo.png",
            "logoRemovedAt" to "",
            "themeId" to "sunset",
            "banner" to mapOf("enabled" to true, "message" to "Closed for the holiday"),
            "chat" to mapOf("enabled" to true, "awayMessage" to "back soon"),
            "home" to mapOf("sections" to listOf(row("upNext", true, 0))),
        )
        val encoded = encodeHomeSections(raw, listOf(PortalHomeSection("upNext", false, 3)))
        assertEquals("https://example.com/logo.png", encoded["logoUrl"])
        assertEquals("sunset", encoded["themeId"])
        assertEquals(mapOf("enabled" to true, "message" to "Closed for the holiday"), encoded["banner"])
        assertEquals(mapOf("enabled" to true, "awayMessage" to "back soon"), encoded["chat"])
        val sections = (encoded["home"] as Map<*, *>)["sections"] as List<*>
        assertEquals(mapOf("id" to "upNext", "enabled" to false, "limit" to 3), sections.single())
    }

    @Test fun `a home map with sibling keys beside sections keeps them too`() {
        val raw = mapOf("home" to mapOf("someFutureKey" to "kept", "sections" to emptyList<Any>()))
        val encoded = encodeHomeSections(raw, listOf(PortalHomeSection("upNext", true, 0)))
        val home = encoded["home"] as Map<*, *>
        assertEquals("kept", home["someFutureKey"])
    }

    @Test fun `encode then decode round-trips a layout unchanged`() {
        val layout = listOf(
            PortalHomeSection("liveVisit", true, 0),
            PortalHomeSection("upNext", false, 5),
            PortalHomeSection("tales", true, 3),
        )
        val roundTripped = decodeHomeSections(encodeHomeSections(null, layout))
        assertEquals(layout, roundTripped)
    }
}
