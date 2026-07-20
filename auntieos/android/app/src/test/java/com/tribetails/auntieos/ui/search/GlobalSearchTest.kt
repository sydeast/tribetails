package com.tribetails.auntieos.ui.search

import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.data.model.KinCareReport
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Unit tests for the pure [globalSearch] matcher and [searchHitRoute] mapping
 * (Stage 0C / Phase 2 shell global search). No Compose / Android / Firebase here.
 */
class GlobalSearchTest {

    private val kinfolk = listOf(
        Kinfolk(id = "kf1", firstName = "Jane", lastName = "Doe", phoneNumber = "555-0100"),
        Kinfolk(id = "kf2", firstName = "Bob", lastName = "Smith", phoneNumber = "555-9999"),
    )
    private val kin = listOf(
        Kin(id = "kn1", name = "Rex", species = "Dog", breed = "Labrador"),
        Kin(id = "kn2", name = "Whiskers", species = "Cat", breed = "Tabby"),
    )
    private val tales = listOf(
        KinCareReport(id = "tl1", sessionId = "s1", title = "Morning walk recap", kinfolkName = "Jane Doe"),
        KinCareReport(id = "tl2", sessionId = "s2", title = "Vet visit notes", kinfolkName = "Bob Smith"),
    )

    @Test fun blankQuery_returnsEmpty() {
        assertTrue(globalSearch("", kinfolk, kin, tales).isEmpty)
        assertTrue(globalSearch("   ", kinfolk, kin, tales).isEmpty)
    }

    @Test fun matchesKinfolkByName() {
        val r = globalSearch("jane", kinfolk, kin, tales)
        assertEquals(listOf("kf1"), r.kinfolk.map { it.id })
        assertTrue(r.kin.isEmpty())
        assertTrue(r.tales.isEmpty())
    }

    @Test fun matchesKinfolkByPhone() {
        val r = globalSearch("9999", kinfolk, kin, tales)
        assertEquals(listOf("kf2"), r.kinfolk.map { it.id })
    }

    @Test fun matchesKinByNameSpeciesBreed() {
        assertEquals(listOf("kn1"), globalSearch("rex", kinfolk, kin, tales).kin.map { it.id })
        assertEquals(listOf("kn2"), globalSearch("cat", kinfolk, kin, tales).kin.map { it.id })
        assertEquals(listOf("kn1"), globalSearch("labrador", kinfolk, kin, tales).kin.map { it.id })
    }

    @Test fun matchesTaleByTitle() {
        val r = globalSearch("vet visit", kinfolk, kin, tales)
        assertEquals(listOf("tl2"), r.tales.map { it.id })
    }

    @Test fun caseInsensitive() {
        assertEquals(listOf("kf1"), globalSearch("JANE", kinfolk, kin, tales).kinfolk.map { it.id })
        assertEquals(listOf("kn1"), globalSearch("LaBrAdOr", kinfolk, kin, tales).kin.map { it.id })
    }

    @Test fun groupsAcrossTypes() {
        // "o" appears in "Doe"/"Bob"/"Dog"/"recap"/"notes"... assert grouping is independent.
        val r = globalSearch("o", kinfolk, kin, tales)
        assertTrue(r.kinfolk.isNotEmpty())
        assertTrue(r.kin.isNotEmpty())
        assertTrue(r.tales.isNotEmpty())
        assertEquals(r.kinfolk.size + r.kin.size + r.tales.size, r.total)
    }

    @Test fun noMatch_isEmpty() {
        assertTrue(globalSearch("zzzznope", kinfolk, kin, tales).isEmpty)
    }

    @Test fun queryIsTrimmed() {
        assertEquals(
            globalSearch("jane", kinfolk, kin, tales).kinfolk.map { it.id },
            globalSearch("   jane   ", kinfolk, kin, tales).kinfolk.map { it.id },
        )
    }

    @Test fun limitPerGroup_caps() {
        val many = (1..20).map { Kinfolk(id = "k$it", firstName = "Match", lastName = "$it") }
        val r = globalSearch("match", many, emptyList(), emptyList(), limitPerGroup = 5)
        assertEquals(5, r.kinfolk.size)
    }

    @Test fun route_kinfolk() {
        val hit = globalSearch("jane", kinfolk, kin, tales).kinfolk.first()
        assertEquals("kinfolk_profile/kf1", searchHitRoute(hit))
    }

    @Test fun route_kin() {
        val hit = globalSearch("rex", kinfolk, kin, tales).kin.first()
        assertEquals("edit_kin/kn1", searchHitRoute(hit))
    }

    @Test fun route_tale() {
        val hit = globalSearch("vet", kinfolk, kin, tales).tales.first()
        assertEquals("kintale/s2?reportId=tl2", searchHitRoute(hit))
    }

    @Test fun route_tale_nullWhenNoSession() {
        val orphan = SearchHit.TaleHit(id = "x", sessionId = "", primary = "t", secondary = "")
        assertNull(searchHitRoute(orphan))
    }

    @Test fun kinSecondary_isSpeciesBreed_omittingBlanks() {
        val hit = globalSearch("whiskers", kinfolk, kin, tales).kin.first()
        assertEquals("Cat · Tabby", hit.secondary)
        val noBreed = globalSearch(
            "rex",
            emptyList(),
            listOf(Kin(id = "k", name = "Rex", species = "Dog", breed = "")),
            emptyList(),
        ).kin.first()
        assertEquals("Dog", noBreed.secondary)
    }
}
