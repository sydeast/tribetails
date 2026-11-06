package com.tribetails.auntieos.domain

import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.MediaFile
import com.tribetails.auntieos.data.model.MediaType
import org.junit.Assert.assertEquals
import org.junit.Test

/** #13 Gallery filter/lookup helpers. Mirrors the web GalleryFiltersTest. */
class GalleryFiltersTest {
    private fun media(
        id: String,
        kinfolk: String = "",
        type: MediaType = MediaType.IMAGE,
        at: String = "2026-06-01",
        tagged: List<String> = emptyList(),
    ) = MediaFile(id = id, kinfolkId = kinfolk, fileType = type, uploadedAt = at, taggedKinIds = tagged)

    private val all = listOf(
        media("a", "k1", MediaType.IMAGE, "2026-06-05"),
        media("b", "k1", MediaType.VIDEO, "2026-05-20"),
        media("c", "k2", MediaType.IMAGE, "2026-06-02"),
    )

    @Test fun filtersByKinfolk() {
        assertEquals(listOf("a", "b"), filterGalleryMedia(all, GalleryFilter(kinfolkId = "k1")).map { it.id })
    }

    @Test fun filtersByTypeAndSortsNewestFirst() {
        assertEquals(listOf("a", "c"), filterGalleryMedia(all, GalleryFilter(fileType = MediaType.IMAGE)).map { it.id })
    }

    @Test fun filtersByMonth() {
        assertEquals(listOf("b"), filterGalleryMedia(all, GalleryFilter(monthPrefix = "2026-05")).map { it.id })
    }

    @Test fun monthsDistinctNewestFirst() {
        assertEquals(listOf("2026-06", "2026-05"), galleryMonths(all))
    }

    @Test fun kinfolkIdsDistinct() {
        assertEquals(listOf("k1", "k2"), galleryKinfolkIds(all))
    }

    @Test fun filtersToUnattachedMediaOnly() {
        val withCompany = all + media("d", "", MediaType.IMAGE, "2026-06-10")
        assertEquals(listOf("d"), filterGalleryMedia(withCompany, GalleryFilter(kinfolkId = "")).map { it.id })
    }

    @Test fun hasUnattachedMediaTrueWhenAnyRowIsBlank() {
        assertEquals(false, galleryHasUnattachedMedia(all))
        assertEquals(true, galleryHasUnattachedMedia(all + media("d", "", MediaType.IMAGE, "2026-06-10")))
    }

    @Test fun hasUnattachedMediaFalseForNoRows() {
        assertEquals(false, galleryHasUnattachedMedia(emptyList()))
    }

    @Test fun taggedNamesResolveAndDropUnknown() {
        val m = media("x", tagged = listOf("k1", "ghost"))
        assertEquals(listOf("Waddles"), taggedKinNames(m, mapOf("k1" to Kin(id = "k1", name = "Waddles"))))
    }

    @Test fun taggableKinScopedToKinfolkWhenKnown() {
        val kin = listOf(Kin(id = "1", kinfolkId = "k1"), Kin(id = "2", kinfolkId = "k2"))
        assertEquals(listOf("1"), taggableKin(media("x", "k1"), kin).map { it.id })
    }

    // #1604: the whole-roster tag list says whose pet is whose.
    private fun petOf(id: String, name: String, kinfolk: String) = Kin(id = id, name = name, kinfolkId = kinfolk)
    private val householdNames = mapOf("k1" to "Halbrook", "k2" to "Alvarez")
    @Test fun groupsKinUnderTheirHouseholdSortedByNameBothLevels() {
        val groups = groupKinByHousehold(
            listOf(petOf("a", "Waddles", "k1"), petOf("b", "biscuit", "k2"), petOf("c", "Archie", "k1")),
        ) { householdNames[it] }
        assertEquals(listOf("Alvarez", "Halbrook"), groups.map { it.label })
        assertEquals(listOf("c", "a"), groups[1].kin.map { it.id })
    }
    @Test fun samePetNameInTwoHouseholdsStaysApart() {
        val groups = groupKinByHousehold(listOf(petOf("a", "Biscuit", "k1"), petOf("b", "Biscuit", "k2"))) { householdNames[it] }
        assertEquals(listOf("Alvarez" to listOf("b"), "Halbrook" to listOf("a")), groups.map { it.label to it.kin.map { k -> k.id } })
    }
    @Test fun unresolvedAndBlankHouseholdsSortLastUnderAPlainWordNeverARawId() {
        val groups = groupKinByHousehold(
            listOf(petOf("a", "Orphan", ""), petOf("b", "Lost", "k-gone"), petOf("c", "Waddles", "k1")),
        ) { householdNames[it] }
        assertEquals("Halbrook", groups[0].label)
        assertEquals(listOf(UNKNOWN_HOUSEHOLD_LABEL, UNKNOWN_HOUSEHOLD_LABEL), groups.drop(1).map { it.label })
        assertEquals(false, groups.any { it.label.contains("k-gone") })
    }
}
