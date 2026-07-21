package com.tribetails.auntieos.web.ui.shell

import com.tribetails.auntieos.web.data.Kin
import com.tribetails.auntieos.web.data.KinCareReport
import com.tribetails.auntieos.web.data.Kinfolk
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Unit tests for the pure [globalSearch] matcher and [routeForSearchResult]
 * route mapping (Stage 0C / Phase 2 shell global search).
 */
class GlobalSearchTest {

    private val kinfolk = listOf(
        Kinfolk(_id = "kf1", firstName = "Jane", lastName = "Doe", phoneNumber = "(555) 123-4567"),
        Kinfolk(_id = "kf2", firstName = "Bob", lastName = "Smith", phoneNumber = "555-999-0000"),
    )
    private val kin = listOf(
        Kin(_id = "kn1", kinfolkId = "kf1", name = "Rex", species = "Dog", breed = "Labrador"),
        Kin(_id = "kn2", kinfolkId = "kf2", name = "Whiskers", species = "Cat", breed = "Tabby"),
    )
    private val tales = listOf(
        KinCareReport(_id = "rp1", sessionId = "se1", kinfolkId = "kf1", kinfolkName = "Jane Doe", title = "Vet visit recap"),
        KinCareReport(_id = "rp2", sessionId = "se2", kinfolkId = "kf2", kinfolkName = "Bob Smith", title = "Morning walk"),
        // No sessionId -> cannot be opened -> must never surface.
        KinCareReport(_id = "rp3", sessionId = "", kinfolkId = "kf1", title = "Unlinked orphan walk"),
    )

    @Test fun `blank query returns nothing`() {
        assertTrue(globalSearch("", kinfolk, kin, tales).isEmpty())
        assertTrue(globalSearch("   ", kinfolk, kin, tales).isEmpty())
    }

    @Test fun `matches kinfolk by display name`() {
        val r = globalSearch("jane", kinfolk, kin, tales)
        assertEquals(listOf("kf1"), r.filter { it.type == SearchResultType.Kinfolk }.map { it.id })
    }

    @Test fun `matches kinfolk by phone digits ignoring formatting`() {
        val r = globalSearch("1234567", kinfolk, kin, tales)
        assertEquals(listOf("kf1"), r.filter { it.type == SearchResultType.Kinfolk }.map { it.id })
    }

    @Test fun `matches kin by name species and breed`() {
        assertEquals(listOf("kn1"), globalSearch("rex", kinfolk, kin, tales).filter { it.type == SearchResultType.Kin }.map { it.id })
        assertEquals(listOf("kn2"), globalSearch("cat", kinfolk, kin, tales).filter { it.type == SearchResultType.Kin }.map { it.id })
        assertEquals(listOf("kn1"), globalSearch("labrador", kinfolk, kin, tales).filter { it.type == SearchResultType.Kin }.map { it.id })
    }

    @Test fun `matches KinTale by title`() {
        val r = globalSearch("vet visit", kinfolk, kin, tales).filter { it.type == SearchResultType.KinTale }
        assertEquals(listOf("se1"), r.map { it.id })
    }

    @Test fun `KinTale without sessionId never surfaces`() {
        val r = globalSearch("orphan", kinfolk, kin, tales)
        assertTrue(r.none { it.id == "" }, "report with blank sessionId must be skipped")
        assertTrue(r.isEmpty(), "only the unlinked orphan title matches 'orphan' and it has no sessionId")
    }

    @Test fun `matching is case insensitive`() {
        assertEquals(listOf("kf1"), globalSearch("JANE", kinfolk, kin, tales).filter { it.type == SearchResultType.Kinfolk }.map { it.id })
        assertEquals(listOf("kn1"), globalSearch("LaBrAdOr", kinfolk, kin, tales).filter { it.type == SearchResultType.Kin }.map { it.id })
    }

    @Test fun `query trims surrounding whitespace`() {
        assertEquals(
            globalSearch("jane", kinfolk, kin, tales).map { it.id },
            globalSearch("   jane   ", kinfolk, kin, tales).map { it.id },
        )
    }

    @Test fun `results are grouped Kinfolk then Kin then KinTale`() {
        // "o" matches Bob (name), Doe (name), Dog/Tabby? -> exercise ordering by type.
        val r = globalSearch("o", kinfolk, kin, tales)
        val types = r.map { it.type }.distinct()
        // distinct group order must follow the fixed enum order.
        val expectedOrder = SearchResultType.entries.filter { it in types }
        assertEquals(expectedOrder, types)
    }

    @Test fun `name match ranks ahead of phone-only match within kinfolk group`() {
        // Two kinfolk: one matches by name on "55", neither by phone here. Use a query
        // where one matches by name and another only by phone.
        val people = listOf(
            Kinfolk(_id = "a", firstName = "Phone", lastName = "Only", phoneNumber = "555000"),
            Kinfolk(_id = "b", firstName = "555 Named", lastName = "Person", phoneNumber = "111111"),
        )
        // Query "555" matches person b by name, person a by phone. Name match ranks first.
        val r = globalSearch("555", people, emptyList(), emptyList()).filter { it.type == SearchResultType.Kinfolk }
        assertEquals(listOf("b", "a"), r.map { it.id })
    }

    @Test fun `no matches yields empty list`() {
        assertTrue(globalSearch("zzzznope", kinfolk, kin, tales).isEmpty())
    }

    @Test fun `per-group results are capped`() {
        val many = (1..20).map { Kinfolk(_id = "id$it", firstName = "Match$it", lastName = "Person") }
        val r = globalSearch("match", many, emptyList(), emptyList())
        assertTrue(r.size <= 6, "kinfolk group should be capped, got ${r.size}")
    }

    // ----- route mapping -----

    @Test fun `kinfolk result maps to directory profile route`() {
        val hit = globalSearch("jane", kinfolk, kin, tales).first { it.type == SearchResultType.Kinfolk }
        val route = routeForSearchResult(hit)
        assertEquals(Destination.Directory, route.dest)
        assertEquals("kf1", route.detailId)
        assertEquals(null, route.detailType)
    }

    @Test fun `kin result maps to directory kin route under its kinfolk`() {
        val hit = globalSearch("rex", kinfolk, kin, tales).first { it.type == SearchResultType.Kin }
        val route = routeForSearchResult(hit)
        assertEquals(Destination.Directory, route.dest)
        assertEquals("kf1", route.detailId)   // kinfolkId
        assertEquals("kn1", route.detailType) // kinId
    }

    @Test fun `KinTale result maps to KinTales report route by sessionId`() {
        val hit = globalSearch("vet", kinfolk, kin, tales).first { it.type == SearchResultType.KinTale }
        val route = routeForSearchResult(hit)
        assertEquals(Destination.KinTales, route.dest)
        assertEquals("se1", route.detailId)
    }
}
