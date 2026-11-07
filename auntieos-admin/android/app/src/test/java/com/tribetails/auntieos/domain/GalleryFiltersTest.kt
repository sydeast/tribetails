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

    // #1588: the Upload dialog's kin picker.
    private fun pet(id: String, name: String, kinfolk: String, status: String = "active") =
        Kin(id = id, name = name, kinfolkId = kinfolk, status = status)
    @Test fun uploadableKinIsOnlyTheChosenHouseholdsActiveKinByName() {
        val roster = listOf(
            pet("p1", "gravy", "k1"),
            pet("p2", "Biscuit", "k1"),
            pet("p3", "Old Boy", "k1", status = "archived"),
            pet("p4", "Mochi", "k2"),
        )
        assertEquals(listOf("p2", "p1"), uploadableKin(roster, "k1").map { it.id })
        assertEquals(listOf("p4"), uploadableKin(roster, "k2").map { it.id })
    }
    @Test fun uploadableKinOffersNothingUntilAHouseholdIsChosen() {
        assertEquals(emptyList<Kin>(), uploadableKin(listOf(pet("p1", "Gravy", "k1")), ""))
        assertEquals(emptyList<Kin>(), uploadableKin(listOf(pet("p1", "Gravy", "k1")), "  "))
    }
}
